# 用量统计、额度周期与缓存语义

[English](./usage-tracking.md) | 中文 · [文档索引](./README.zh.md) · [README](../README.zh.md)

本文档说明 **用量看板**（`src/usage/*`）的内部架构、额度窗口生命周期与多进程持久化设计，以及状态栏用量胶囊与设置页共享实时额度快照的缓存机制。

## 统计范围与隐私边界

- **纳入统计的服务商**：`codex`、`claude`、`grok` 与 `antigravity`（见 `src/usage/constants.ts` 中的 `USAGE_TRACKED_PROVIDERS`）。
- **排除的服务商**：**Copilot** 不提供订阅用量/额度窗口接口，因此不纳入用量看板。
- **隐私边界**：插件仅在 `~/.dsh/plugins/subscriptions/usage/` 下保存按模型与 UTC 自然日聚合的 token 计数、观测到的额度使用占比（`quotaUsedPercent`、`quotaPeakPercent`）及窗口边界元数据。**绝不**在此保存提示词、回复内容、凭据或逐请求日志；打开看板不会额外发起上游额度请求，也不做费用估算。

## 本地存储目录结构

所有用量文件均存放在 `~/.dsh/plugins/subscriptions/usage/` 下（写入文件权限为 `0600`）：

```text
~/.dsh/plugins/subscriptions/usage/
├── meta.json                  # 开始统计时间与各服务商的清空截断时刻
├── meta.lock                  # 更新 meta.json 时的临时锁文件
└── <provider>/                # codex | claude | grok | antigravity
    ├── open.json              # 各账号当前处于打开状态的窗口条目
    ├── closed-YYYY.jsonl      # 按 UTC 年份追加写入的已关闭/提前结束窗口条目
    ├── pre-tracking.json      # 一次性折叠的 trackingStartedAt 之前各服务商 UTC 逐日历史汇总（v2）
    └── <provider>.lock        # 单个 provider 保存/清空时的临时锁文件
```

损坏的文件或畸形 JSONL 行会被跳过并记录到 `errors[]`，不会导致看板整体失败；文件读取诊断只返回错误码，不暴露宿主绝对路径。

## 窗口生命周期与去重规则

`WindowTracker`（`src/usage/window-tracker.ts`）是一个纯同步状态机，由三类事件驱动：额度快照、请求完成事件，以及已确认的 Codex 重置卡兑换事件。

### 窗口类型与起止锚定

- **窗口类型**：`5h`（对应 `session`）、`weekly`、`monthly`（按观测时长落在 `28d–31d` 归类）、`unclassified`（完成归类前隐藏），以及 `pending`（账号收到首次额度快照前的账号级 Window 0）。
- **起始时间来源（`StartSource`）优先级**：
  1. `disclosed`：服务商直接披露周期起始时间（`grok` 通过 `currentPeriod.start`）。
  2. `length`：服务商披露精确窗口时长（`codex` 通过 `limit_window_seconds`）。
  3. `nominal`：固定名义时长（`5h` 或 `7d`，用于 `claude` 及兜底场景；月度窗口无固定名义时长）。
  4. `previous-reset`：直接衔接上一个窗口的 `resetsAt`。
  5. `redemption`：插件内确认兑换 Codex 重置卡的精确时刻（同时切分 `5h` 与 `weekly` 窗口）。
  6. `first-usage` / `observed`：Window 0 或无上述规则可用时的兜底起点（例如外部触发提前重置后首次观测到新窗口）。
- **提前重置识别与抖动容差**：若新观测到的重置时间与当前打开窗口的 `resetsAt` 差值在 `60s` 以内（`RESET_MATCH_TOLERANCE_MS`），视为同一窗口（吸收相对字段 `reset_after_seconds` 的请求延迟抖动）；差值大于 `60s` 则将旧窗口标记为 `ended-early`（`endReason: 'detected'`）并开启新窗口。

### Token 分桶与跨窗口去重

- 每个模型汇总记录五个分桶：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`。其中 **推理 token（`reasoningTokens`）是 `outputTokens` 的子集**，在 `totalTokens`（`input + output + cacheRead + cacheWrite`）中绝不重复计算。
- 仅 **Claude** 会在 `cacheWriteTokens` 下额外记录 `cacheWrite5mTokens` 与 `cacheWrite1hTokens` 两个时长子桶。
- **跨窗口去重（`src/usage/usage-dashboard.ts`）**：单次请求可能同时落入同一账号的 `5h` 窗口、每周窗口以及按模型作用域划分的窗口。为防止在每日趋势、热力图和 KPI 汇总中重复计数，聚合器会为每个 `(provider, account, day, model)` 选出一个规范序列——取 token 总量最高者，相同时按 `weekly > 5h > monthly > pending`（优先无 scope 窗口）打破平局——同时保留互不重叠的模型分组作用域（例如 Antigravity 的 Gemini 组与 Claude/GPT 组）各自独立统计。

## 多进程并发与持久化保障

`WindowStore`（`src/usage/window-store.ts`）负责协调共享同一 `$DSH_HOME` 的多个并发 DSH 进程（例如 web 与 headless 会话并存）：

- **请求路径零 I/O**：请求完成和快照钩子仅同步更新内存状态，并调度延迟写盘（自首次未保存变更起延迟 `5s`，`USAGE_SAVE_DELAY_MS`）。窗口关闭时立即落盘；`60s` 推进定时器（`USAGE_ADVANCE_INTERVAL_MS`）保证无流量时过期的窗口也会及时关闭保存。
- **加锁增量读-并-写**：保存时先获取 `<provider>.lock`（超时 `10s` 视为陈旧锁并接管，`USAGE_LOCK_STALE_MS`；进程退出最多等待 `2` 个锁周期），读取磁盘最新状态，仅合并本进程的**未保存增量（unsaved deltas）**，再通过 `.tmp-*` + `rename` 原子替换。两个并发进程不会互相覆盖已提交的统计数据。
- **崩溃恢复（“已关闭优先”）**：关闭窗口时，先向 `closed-YYYY.jsonl` 追加条目，**随后**再重写 `open.json`。若两次写入之间崩溃导致同一窗口 ID 同时出现在两处，加载时以已关闭副本为准。
- **清空历史（`clearProvider`）**：先向 `meta.json` 写入单调递增的 `clearedAt` 截断时间戳，再清理该 provider 的文件。即使其他进程内存里仍有未刷盘条目，或部分文件删除失败，所有 `countedFrom < clearedAt` 的条目都会立即隐藏，后续保存会自动重试清理。
- **一次性历史会话折叠（`src/usage/pre-tracking.ts`）**：当宿主提供 `sessionQuery` 服务时，后台任务会一次性将 `trackingStartedAt` 之前的 DSH 会话历史折叠写入 `<provider>/pre-tracking.json`（`v2`），按服务商存储 UTC 逐日分桶（`days`，读取时由 `days` 推导各模型汇总 `models` 以保证一致；仅保留互斥基础分桶并按 `(turn, step)` 槽位去重，不记录账号/会话身份或 Claude `5m`/`1h` 缓存写入拆分）。这些逐日数据仅合入用量看板的 **全部账号** 视图（KPI、26 周热力图、每日趋势、模型/服务商分布及服务商胶囊），单账号视图与额度周期图仍仅统计台账数据。旧版 `v1` 文件（仅有按模型总计、无 `days`）仍可正常读取并会在后台重新扫描升级为 `v2`；缺少或带有无效时间戳的事件会被跳过，已清空服务商的历史逐日数据会被忽略。写入 `v2`（或清空）后，读取用量状态不再重新扫描 DSH 会话。

## 实时用量胶囊与设置页缓存行为

**设置 → 订阅** 页面与输入框 **订阅用量胶囊** 共享两层实时额度缓存：

1. **服务端缓存（`PoolUsageTracker`，`src/providers/pool-usage.ts`）**：
   - 成功获取的快照保鲜 `5 分钟`（`USAGE_TTL_MS`）。
   - 拉取失败进入负缓存冷却（优先遵守接口返回的 `retry-after`，否则 `5 分钟`），同时保留上一次成功快照（`lastSnapshot`，附带 `stale: true`、`refreshFailed: true` 与 `retryAt`），避免界面闪烁为空或触发 429 重试风暴。
   - 点击设置页账号旁的 **刷新** 按钮会发送 `force: true` 跳过未过期缓存，但**绝不**绕过生效中的失败冷却。打开用量胶囊则执行普通（非强制）读取。
   - `displaySnapshotFor` 仅在返回给 UI 的副本上附加 `fetchedAt`、`staleAt`、`stale`、`refreshFailed` 与 `retryAt`，不改变模型池调度评分。
2. **客户端连接级内存缓存（`src/client/usage-cache.ts`）**：
   - 同一连接下打开的设置页与状态栏用量胶囊通过仅存内存的 `WeakMap` 共享成功的 `usage` 响应（不落盘、不写 `localStorage`），窗口获焦时只重读该内存缓存，不额外发上游请求。
   - 当 `status` 显示某账号已退出登录时，`retainUsageAccounts` 会立即从客户端缓存中移除该账号。
   - 若旧版后端未提供 `fetchedAt`，前端会记录本地收到响应的时间 `receivedAt` 并明确区分展示——收到时间绝不会伪装成上游额度刷新时间。
