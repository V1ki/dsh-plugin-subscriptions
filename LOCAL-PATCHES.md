# dsh-plugin-subscriptions（本地自维护分支）

上游：https://github.com/V1ki/dsh-plugin-subscriptions （v0.9.12，commit `be350cd`）

本目录是该插件的**打过补丁的源码树**，用于自维护。原因：上游存在三个真实缺陷，
其中两个会导致"插件看起来在跑、但完全不可用"。

## 为什么不用 npm 版

npm 发布的是**完全打包**的单文件 `lib/index.js`（约 490 KB，无相对 import）。
DSH 只加载这一个文件。

因此安装包里 `lib/translate/responses.js`、`lib/http.js`、`lib/auth/store.js`
这些**独立文件根本不会被加载**——它们只是 `pnpm build`（tsc 开发构建）的残留。
曾经把补丁打进 `translate/responses.js`，看起来成功，实际零效果。

**结论：任何修复都必须改源码，然后 `pnpm run prepare` 重新打包。**

## 三个缺陷

### A. 配置文件不容忍 UTF-8 BOM（最严重）

插件用 `JSON.parse` 直接读自己拥有的所有 JSON 配置，而 Windows 常规工具会带 BOM：

```powershell
Set-Content -Encoding UTF8   # PowerShell 5.1 → EF BB BF
Out-File -Encoding utf8      # 同上
# 记事本"UTF-8 带 BOM"         # 同上
```

后果分两级：

| 文件 | BOM 后果 |
|---|---|
| `proxy.json` | 单次懒加载抛错 → **代理整个进程生命周期失效** → 请求走裸连接 → `TRANSPORT` |
| `provider-settings.json` | 加载即抛 `Cannot read provider settings` → **整个插件起不来** |
| `auth.json` | 读成"全部未登录" |
| `models.json` | 模型目录读空，下拉退回静态列表 |
| model-defaults | 插件加载抛错 |

其中 proxy.json 那处是实际发生的线上故障：DNS 被污染到 Facebook IP，直连必然超时，
而代理因一个 BOM 静默关闭，症状表现为远离根因的 `codex API request failed`。

修复：`src/json-text.ts` 提供 `stripBom` / `parseJsonText`，5 处文件读取全部改走它。

### B. 流式 `error` 事件读错字段路径

真实报文（`chatgpt.com/backend-api/codex` 实测）：

```json
{"type":"error","sequence_number":3,
 "error":{"code":"server_is_overloaded",
          "message":"Our servers are currently overloaded...",
          "headers":{"retry-after":"314","retry-after-ms":"314000"}}}
```

真实数据在 `event.error.*`，但 `case 'error'` 读的是 `event.code` / `event.message`
——**两者都是 undefined**。于是所有上游失败都退化成
`the provider reported a failed response`，且丢失退避提示。

修复：读 `event.error?.code ?? event.code`（保留 Copilot 那种扁平形态），
并把 `headers` 一并传入。

### C. 丢弃上游 `retry-after`

`responsesFailure` 只取 code/message，`retry-after` 被丢掉。后果叠加：

- `SERVER` 失败 → 成员冷却 `TRANSIENT_COOLDOWN_MS = 60s`
- 单成员池 → 冷却期内无可用成员 → **立即抛 exhausted，不等待**
- 本地退避（1s/2s/4s…）全部落在冷却窗口内 → 连续"秒失败"

日志实证（`session-b01de005`）：

```
20:13:02  20:14:07  20:15:19  20:16:32     ← 每 ~65-73s 一次
每次都带 "earliest member recovers in 1m00s"
```

修复：`retryAfterMsFromPayload()` 解析 `retry-after-ms`（毫秒）与 `retry-after`
（秒），挂到 `LlmError.failure.providerRetryAfterMs`。

上游重试插件本身有保护（`dsh-llm-retry`）：

```js
if (failure.providerRetryAfterMs > policy.maxDelayMs) {
  if (policy.mode === 'normal') return next();   // 超上限则放弃，不傻等
  delayMs = localDelay(delayMs);
} else delayMs = failure.providerRetryAfterMs;
```

codex 的 `maxDelayMs = max(60s, 6h) = 6h`，而提示约 317s < 6h，
因此提示会被如实采纳，不会触发"放弃重试"。

## 构建与部署

```bash
pnpm install --ignore-scripts
pnpm exec tsc --noEmit        # 类型检查
pnpm test                     # 666 个测试
pnpm run prepare              # ← 打包成发布形态（不是 pnpm build！）
```

`pnpm build`（tsc + tsdown）输出**分模块**的 lib/，与 npm 发布形态不同。
要部署到 DSH 必须用 `pnpm run prepare`。

部署：

```powershell
.\scripts\fix-dsh-subscriptions-bom.ps1 -BuildFromSource
# 然后重启 DSH Next
```

体检（不改任何东西）：

```powershell
.\scripts\fix-dsh-subscriptions-bom.ps1 -CheckOnly
```

## 测试基线（重要）

上游干净代码在**本机**就有 30+ 个失败，全部是
`codex API stream idle timeout` / `grok API stream idle timeout`
——mock 服务器与 Node 版本的超时问题，与本补丁无关。

对比口径：

```
上游干净            : 32 failures
本补丁              : 27 failures
新增失败            : 0
修复的原有失败      : 5
```

新增测试 `test/responses-failure.spec.ts`（8 个）覆盖两个缺陷，
包括用真实报文验证"旧的字段路径会丢信息"。

## 上游状态

这些缺陷在上游源码中真实存在：

- `src/translate/responses.ts:486` — `responsesFailure(event.code, event.message)`
- `src/translate/responses.ts:269` — `responsesFailure` 无 headers 参数
- `src/http.ts` / `auth/store.ts` / `providers/catalog-store.ts` /
  `model-defaults.ts` / `provider-settings.ts` — 裸 `JSON.parse`

建议向上游提 issue + PR；若上游合并，本分支可退役。
