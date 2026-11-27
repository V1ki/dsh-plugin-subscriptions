# 模型池、付费额度兜底与限流处理

[English](./pool-and-rate-limits.md) | 中文 · [文档索引](./README.zh.md) · [README](../README.zh.md)

本文档说明 `PoolAdapter` 的账号调度机制、订阅额度耗尽与 Codex 付费 credits 兜底规则、失败分类与冷却策略、各服务商 429 重置信号解析，以及 Codex 重置卡手动兑换的安全护栏。

图片工具的独立账号调度（与对话模型池分离），请参阅[图片账号调度](./image-account-pool.zh.md)。单账号池白名单与独立账号模型入口，请参阅[账号与模型管理](./account-management.zh.md)。

## 账号池、`families` 与 `tiers`

当同一 provider 登录了两个及以上账号，且 `pool.enabled` 与 `pool.autoAccounts` 均开启时，模型选择器会展示所有符合条件账号的模型目录**并集**（按模型 ID 去重）：

- **共有模型**（≥2 个账号列出）：在对应账号间自动 failover，并保持按会话粘性。
- **单账号模型**（仅 1 个账号列出）：直接路由到该账号；即使该账号不是默认账号，模型仍会出现在选择器中。
- **显式 `pool.families`**：替换指定目录模型的自动成员列表（仅限同一 provider，跨 provider 成员会被忽略）。
- **可选 `pool.tiers`**：在首个成员所属的 provider 分组下新增额外的选择器条目，支持跨模型或跨 provider 的异构回退列表。
- **保守能力交集**：`resolveModel` 对所有成员的 `contextWindow`（取最小值）、`defaultMaxTokens`（取最小值）、`reasoning.efforts`（取交集）与 `inputModalities`（取交集）求交集，确保 failover 后请求依然合法。

### 账号 Key 解析（`pool.families` / `pool.tiers`）

- 省略 `account` 时解析为该 provider 当前的默认账号。
- Claude、Grok、Copilot 与 Antigravity 的 `account` 为稳定账号 key（通常是邮箱或登录名）。
- **Codex** 的规范账号 key 同时包含 workspace 与用户（`["<workspace-id>","user","<user-id>"]`）。在配置中可以填写规范 key、登录邮箱，或裸 workspace ID（仅当该 workspace 下只登录了一个用户时有效）。存在歧义的引用不会解析到任何账号，避免误打到其他账号。

## 调度策略与额度分层

所有策略都会先过滤掉 adapter 不可用、正在 `PoolHealthRegistry` 冷却中，或已**耗尽**（任一适用窗口 `usedPercent >= 100` 且没有可用 Codex 付费 credits）的成员。

当所有当前可用成员均已耗尽且均无可用 credits 时，调度会立即抛出 `QUOTA` 错误并停止请求，避免静默扣费。

### 付费 Credits 兜底层（`creditFunded`）

针对 Codex 账号（`src/providers/pool-usage.ts` 中的 `codexCreditsFunded`）：

- 当适用窗口已达 `>= 100%` 时，仅当 `credits` 表明仍有可消费余额时账号才保持候选资格：`overageLimitReached !== true`，且满足 `unlimited === true`、有限数值 `Number(balance) > 0`，或 `balance === undefined && hasCredits === true`。
- 在**所有**策略下，候选成员都严格分为两个优先级层级：
  1. **订阅包含额度（`included`，`creditFunded !== true`）**：所有仍有订阅包含额度的账号（包括用量在 `95%–99%` 的接近满额账号）。
  2. **付费 Credits 兜底（`creditFunded === true`）**：订阅窗口已达 `>= 100%` 但仍有可用 Codex credits 的账号。此类账号永远排在所有仍有包含额度的账号**之后**。

### 策略对比

| 策略 | 排序公式 | 接近满额（`95%–<100%`） | 会话粘性 |
| --- | --- | --- | --- |
| `priority` | 在 `included` 内按配置/默认顺序排列，随后是 `creditFunded`。 | 与其他 `included` 成员同等对待。 | 只要粘性成员未冷却、未耗尽且 `stickySpendsCredits` 为 `false`（即不存在“粘性成员在花 credits 而池中仍有 `included` 成员”的情况），则保持粘性。 |
| `quota_aware`*（默认）* | 必需消耗速率：跨适用窗口取 `max(remaining / timeUntilReset)`（每毫秒需消耗的窗口比例）。缺少 `resetsAt` 时回退到 `5h` / `7d` / `30d` 基准；无用量遥测的 provider（如 Copilot）得分为 `0`。 | 归入 `nearFull` 排在 `< 95%`（`scored`）之后，组内仍按消耗速率排序，并始终排在 `creditFunded` 之前。 | 在 `scored` 内，除非 `bestUrgency > stickyUrgency * switchMargin`（默认 `2`），否则保持粘性。当 `scored` 为空时，仅在 `!stickySpendsCredits` 时才在 `quotaFull`（`[...nearFull, ...creditFunded]`）中保持粘性——因此粘性 `creditFunded` 账号会让位于 `95%–99%` 的包含额度账号，但在所有包含额度都耗尽后仍保持粘性。 |
| `quota_normalized` | 无量纲相对进度评分：`remaining / clamp(timeLeft / durationMs, 0.001, 1)`。缺少 `durationMs` 或 `resetsAt` 时仅按 `remaining` 评分，不猜测窗口总时长。 | 与 `quota_aware` 相同的 `95%` 后备组、`100%` 排除及 `creditFunded` 最后兜底层。 | 与 `quota_aware` 相同的滞后倍率及 `!stickySpendsCredits` 规则。 |

粘性与用量缓存补充说明：

- 粘性按 `sessionId|poolId` 缓存在内存中（LRU 上限 `1000` 条），仅在成员实际输出第一个非 `usage` 内容块后才会更新。
- `PoolUsageTracker` 将用量快照缓存 `5 分钟`（健康成员采用 stale-while-revalidate 后台刷新）。已耗尽与 `creditFunded` 快照在过期后会阻塞等待新一次拉取，以便重置或余额耗尽立即影响当次路由。拉取失败会进入负缓存冷却，并在下次成功刷新前保留先前已知的耗尽或 `creditFunded` 状态。

## 失败分类与冷却策略

Failover 仅发生在输出首个内容块**之前**（前置 `usage` 元数据块会先缓冲）。冷却记录仅存在于内存中（`PoolHealthRegistry`，`src/providers/pool-health.ts`），进程重启或账号登录/退出时自动清空。

| 错误码 | 处理动作 | 冷却时长 | 冷却范围 |
| --- | --- | --- | --- |
| `QUOTA`、`RATE_LIMIT` | 切换成员并使该账号用量缓存过期 | 优先使用服务商披露的 `retry-after` / 重置时间，否则 `5 分钟`（`DEFAULT_QUOTA_COOLDOWN_MS`） | `claude` 与 `antigravity` 为**单成员**（按模型限额）；`codex`、`grok`、`copilot` 为**整账号**。 |
| `ACCOUNT_SUSPENDED` | 切换成员 | `24 小时`（`AUTH_COOLDOWN_MS`） | 整账号 |
| `AUTH`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL` | 切换成员 | `24 小时`（`AUTH_COOLDOWN_MS`，重新登录后立即清除） | 整账号 |
| `SERVER` | 切换成员 | `60 秒`（`TRANSIENT_COOLDOWN_MS`）；Codex 在 SSE 过载错误披露 `retry-after` 时优先采用该值 | 单成员 |
| `TIMEOUT`、`HTTP_402`、`HTTP_404` | 切换成员 | `60 秒`（`TRANSIENT_COOLDOWN_MS`） | 单成员 |
| `EMPTY_RESPONSE`、`TRANSPORT` | 切换成员 | **无冷却**（不记录冷却，其他会话仍可立即使用该成员） | — |
| `CONTEXT_WINDOW_EXCEEDED`、`ABORTED`、`HTTP_400`、图片输出错误及其他错误 | 立即抛出 | 无 | — |

## 各服务商 429 重置信号与等待策略

仅在 HTTP `429` 上解析能够明确指明“是哪个限流窗口拒绝了本次请求”的信号（`src/providers/rate-limit.ts` 与 `src/providers/common.ts`）：

| 服务商 | 采信的 429 重置信号（按优先级） | 刻意忽略的头（仅作诊断日志） |
| --- | --- | --- |
| **Codex** | JSON 响应体字段 `resets_in_seconds`、`reset_after_seconds`、`resets_at`、`reset_at` → 回退 `retry-after` 头 | `x-codex-{primary,secondary}-reset-after-seconds`（每次响应均携带的滚动快照） |
| **Claude** | `anthropic-ratelimit-unified-reset`、`anthropic-ratelimit-unified-fallback-reset` 头 → JSON 响应体 `resets_at`、`resetsAt`、`reset_at`、`retry_after` → 回退 `retry-after` 头 | `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset`（各分桶滚动快照） |
| **Grok** | JSON 响应体字段 `retry_after`、`retry_after_seconds`、`resets_at`、`reset_at` → 回退 `retry-after` 头 | `x-ratelimit-reset-*`（各分桶滚动快照） |
| **Antigravity** | JSON 响应体 `quotaResetDelay` / `quotaResetTimeStamp`（`googleQuotaReset`）→ 回退 `retry-after` 头 | — |
| **Copilot** | RFC 7231 `retry-after` 头 | 未识别的 GitHub 限流头通过 `onWarn` 输出诊断 |

若 429 未携带任何已识别的重置时刻，会向 `onWarn` 输出一行诊断日志，列出相关限流头与响应体前 200 字符。

### 重试策略与 `rateLimit.maxWaitMs`

- 五条订阅路由向 `@deepseek-ai/dsh-llm-retry` 声明同一套基础重试形状：首次尝试后最多重试 `10` 次，从 `1s` 起指数退避并带 `20%` 抖动，本地退避上限 `60s`（`DEFAULT_RETRY`）。
- 对服务商披露的重置时刻会额外加上 `2s` 时钟偏差余量（`RESET_GRACE_MS`，下限 `1s`），且作为 `providerRetryAfterMs` 上报时**刻意不做截断**。当等待时长超过 `rateLimit.maxWaitMs`（默认 `6 小时`）时，`@deepseek-ai/dsh-llm-retry` 会立即让本轮失败并附带真实重置时刻，而不是把重试预算浪费在尚未重开的窗口上。
- **与账号池的协作**：池中单个账号返回 429 时会冷却并立即 failover 到下一个健康账号，无需等待。只有当池中**所有**成员都在冷却时，才会向上抛出 `RATE_LIMIT` 并携带池中最早的恢复时间。
- **退避上限取舍**：启用 `rateLimit.wait: true` 时，路由的 `maxDelayMs` 会放宽至 `max(60s, rateLimit.maxWaitMs)` 以接受较长的窗口等待。由于该上限同时作用于本地指数退避，未披露重置时间的瞬时错误（`TRANSPORT`、`SERVER`、`TIMEOUT`）在第 10 次重试时单次退避最长可达 `512s`（而非 `60s`）。设置 `rateLimit.wait: false` 可恢复 `60s` 上限（10 次重试总计约 5 分钟）。

## Codex 重置卡手动兑换护栏

手动兑换已囤积的重置卡（`src/providers/reset-redemption.ts`，通过 **设置 → 订阅** 触发）包含严格保护，防止误扣或重复提交：

1. **手动两步确认**：`prepareReset` 会重新拉取实时用量，选择最快过期的可用重置卡，并签发一个**一次性、有效期 60 秒的确认票据（ticket）**。
2. **使用门槛校验**：只有当刷新后的账号级每周窗口已用率 `>= 80%`、存在未来的 `resetsAt` 且无 `resetCreditsError` 时才允许兑换。
3. **结果不确定时禁止盲目重试**：调用 Codex `/consume` 接口前，账号会被加入内存中的 `uncertain` 锁定集合。若提交过程中发生网络异常或响应结果不明确，该账号的后续兑换操作会持续被拦截，直到用户在 Codex 中核实状态。
4. **精确切分用量窗口**：仅当 `/consume` 明确返回 `code: "reset"` 后，才会通知用量追踪器（`onRedeemed`）在该精确时间戳切分该账号的 `5h` 与 `weekly` 窗口。
