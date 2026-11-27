# 服务商参考

[English](./providers.md) · [文档目录](./README.zh.md)

本文档汇总 `dsh-plugin-subscriptions` 各订阅服务商的认证流程、上游端点、协议细节与高级选项。YAML 配置项与本地存储路径请见[配置与本地存储](./configuration-and-storage.zh.md)；多账号故障切换与冷却策略请见[账号池与限流机制](./pool-and-rate-limits.zh.md)。

---

## ChatGPT (Codex)

### 认证与账号标识

- **OAuth 流程**：基于授权码 + PKCE 对接 `https://auth.openai.com/oauth/authorize` 与 `https://auth.openai.com/oauth/token`，使用官方 Codex CLI 客户端 ID（`app_EMoamEEZ73f0CkXaXp7hrann`），本地回调监听 `localhost` 端口 `1455` 或 `1457`（`/auth/callback`）。
- **令牌刷新**：授权码换取令牌采用 `application/x-www-form-urlencoded`，刷新令牌采用 JSON（`grant_type: "refresh_token"`），并在到期前 5 分钟提前刷新。遇到永久性刷新错误码（`refresh_token_expired`、`refresh_token_reused`、`refresh_token_invalidated`、`invalid_grant`）时会移除已存会话并提示重新登录。
- **工作区 + 用户复合账号 Key**：会话按 JSON 元组 `[chatgpt_account_id, "user", chatgpt_user_id]` 建键（依次回退到 `[chatgpt_account_id, "email", email]`，以及旧版无身份信息会话的纯 `accountId`），确保同一 ChatGPT Team/Enterprise 工作区下的多个用户互不覆盖。旧版仅按工作区建键的记录会自动原地迁移并保留别名映射（`src/auth/store.ts`）。

### 端点与目录版本自动探测

- **Responses 流式接口**：`https://chatgpt.com/backend-api/codex/responses`（仅流式，`store: false`，`include: ["reasoning.encrypted_content"]`，`prompt_cache_key: sessionId`，并携带确定性 `session-id` 请求头）。
- **模型目录**：`https://chatgpt.com/backend-api/codex/models?client_version=<version>`。会过滤掉 `visibility` 为 `hide` 或 `none` 的条目，并按 `priority` 排序。
- **npm `@openai/codex` `client_version` 自动查询**：由于后端会根据 `client_version` 过滤可见模型，`CodexClientVersionCache` 会惰性查询 `https://registry.npmjs.org/@openai%2fcodex/latest`（无凭据、5 秒超时、成功缓存 6 小时 / 失败缓存 5 分钟、下限为内置 `0.153.4` 且永不降级）。在插件配置中显式设置 `codexClientVersion` 可覆盖该自动查询。
- **Happy Eyeballs 建连超时下限**：插件启动时，`src/http.ts` 会将 Node 的 `net.autoSelectFamilyAttemptTimeout` 提升至至少 `1500` ms（`MIN_CONNECT_ATTEMPT_TIMEOUT_MS`，插件卸载时恢复原值），避免在高延迟链路上访问 Cloudflare 代理域名（如 `registry.npmjs.org`、`chatgpt.com`）时因 Node 默认 250 ms 超时导致双栈建连全部失败。

### 上下文上限、推理档位、极速模式与协议修复

- **上下文窗口封顶**：内置回退值为 `400,000` token（`CODEX_CONTEXT_WINDOW`）与 `8,192` 本地输出预留（`CODEX_DEFAULT_MAX_TOKENS`，仅用于 DSH 本地上下文预算，并非 API 生成上限）。设置页中的单模型（`contextWindows`）或 Codex 全局（`contextWindow`、`defaultMaxTokens`）覆盖值始终受当前服务账号上报的 `max_context_window`（若缺失则为目录默认 `context_window`）封顶。
- **极速模式与子代理默认速度**：目录中声明了 `service_tiers` ID `"priority"`（或旧版 `additional_speed_tiers` `"fast"`）的模型会在输入框显示速度开关，启用 `fast` 时在请求体中发送 `service_tier: "priority"`，`standard` 时省略该字段。主会话的按模型选择持久化于 `model-speeds.json`。子代理会话（`origin === "subagent"`）读取 `provider-settings.json` 中的 `subagentSpeeds`（默认 `standard`），独立于主会话速度设置。
- **`ultra` → `max` 档位降级**：Codex 的 `ultra` 属于客户端专属模式，Responses API 直接收到会返回 HTTP 400。目录发现会过滤掉 `ultra`，`codexWireEffort` 也会在协议边界将历史遗留的 `ultra` 降级为 `max`。
- **工具调用 ID 归一化与配对修复**：`normalizeCodexCallIds` 保持长度 ≤ 64 字符的 ID 原样不变，将超长 ID 确定性哈希为 `call_<sha256>`（先保留请求中所有合法短 ID 避免碰撞）。`reconcileResponsesToolCalls` 在请求侧为缺失结果的调用补齐“结果未知”占位输出并剔除孤立输出，不修改持久化对话历史。

### 用量、购买额度、重置卡与工具

- **用量查询（`wham/usage`）**：`https://chatgpt.com/backend-api/wham/usage` 读取限流窗口与额度信息且不消耗配额。由于后端有时会把周窗口放在 `primary_window` 中，窗口类型按 `limit_window_seconds` 分类（5 小时会话 / 7 天周窗口允许 ±5% 容差，仅在缺少时长字段时回退到槽位顺序）。
- **购买额度（Credits）**：从 `wham/usage` 解析 `credits`（`balance`、`unlimited`、`has_credits`、`overage_limit_reached`）并在设置页与状态栏展示。界面会隐藏非正数值余额（`<= 0`）；正余额账号在订阅窗口耗尽后可作为账号池兜底候选（详见[账号池与限流机制](./pool-and-rate-limits.zh.md)）。
- **手动重置卡**：从 `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` 读取可用的 `codex_rate_limits` 重置卡，仅在用户显式确认后调用 `/consume` 核销。安全护栏（`src/providers/reset-redemption.ts`）：要求实时周用量 ≥ 80%、签发 60 秒一次性确认票据、提交结果不确定时将账号锁定为 `uncertain` 防止重复消耗，确认成功后通知用量追踪器切分窗口。
- **`web_search` 与 `image_generate` 工具**：
  - 将 `CodexWebSearchProvider` 注册到 DSH 原生 `web_search` 能力插槽（`ctx.web`），调用 `https://chatgpt.com/backend-api/codex/alpha/search`（模型 `gpt-5.6-terra`，传输/5xx 最多尝试 5 次，响应上限 2 MiB）。在设置中关闭 Codex 的 `web_search` 开关只会令其 `available()` 返回 `false`，将能力让渡给其他已注册搜索服务商，而不会禁用宿主工具。
  - 作为 `image_generate` 的默认首选服务商（`gpt-image-2`，经 `/backend-api/codex/images/{generations,edits}`），通过[图片账号调度](./image-account-pool.zh.md)管理多账号。

---

## Claude (Anthropic)

### 认证：Keychain 同步与独立 OAuth

- **Claude Code 凭据同步**：点击登录时优先读取 Claude Code 原生凭据存储——macOS 钥匙串条目 `Claude Code-credentials`，失败或非 macOS 时回退到 `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`。导入的账号会标记为 `keychainBound: true`。
  - 插件每 5 分钟对绑定账号执行一次后台同步；刷新时走 `refreshClaudeSynced`：先检查外部（如 `claude` CLI）是否已轮换出更新的令牌，若由本插件执行刷新则会回写至 Claude Code 凭据存储（`writeBackClaudeCodeCredentials`），保持双方同步。
- **独立浏览器 OAuth**：显式选择浏览器登录（或本地无 Claude Code 凭据）时，通过 `https://claude.ai/oauth/authorize` 与 `https://claude.ai/v1/oauth/token` 运行 PKCE 流程（随机空闲 `localhost` 端口 `/callback`）。独立账号不设置 `keychainBound`，到期前 5 分钟独立刷新，避免多个 Claude 账号争抢同一份钥匙串条目。

### 端点与 CLI 身份伪装

- **Messages API**：`https://api.anthropic.com/v1/messages?beta=true`（`anthropic-version: 2023-06-01`、`x-app: cli`、`anthropic-dangerous-direct-browser-access: true`）。每次请求都会将必需的 Claude Code 身份声明作为首个 `system` 块。
- **模型目录与用量**：`https://api.anthropic.com/v1/models?beta=true`（读取 `max_input_tokens`、`max_tokens`、`enabled`/`adaptive` 思考类型及支持的推理档位）与 `https://api.anthropic.com/api/oauth/usage`（同时兼容新版 `limits` 数组与旧版 `five_hour`/`seven_day*` 字段）。
- **CLI 版本声明**：发送 `User-Agent: claude-cli/<version> (external, cli)`，版本号由 `ClaudeCliVersionCache` 从 `https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest` 解析，下限取本机 `claude --version` 与内置 `2.1.283` 中较新者。

### 提示缓存（`claudePromptCacheTtl`）

- **TTL 模式**：`'5m'`（默认——仅发送 `{ type: "ephemeral" }` 省略 `ttl`，写入按基础输入价 1.25× 计费）或 `'1h'`（发送 `{ type: "ephemeral", ttl: "1h" }`，写入按基础输入价 2× 计费）。两种时长下的缓存读取价格一致。
- **优先级与设置页实时覆盖**：可在 YAML 中配置 `claudePromptCacheTtl`，也可在 **设置 → 订阅 → Claude → 管理 → 提示缓存有效期**（写入 `provider-settings.json` 的 `promptCacheTtl`）无需重启实时覆盖。携带 `purpose` 的辅助请求（如上下文压缩、会话标题生成）始终保持 `5m`。
- **缓存断点规则**：Anthropic 单次请求最多允许 4 个断点，且禁止在 `5m` 标记之后出现 `1h` 标记，因此同一请求所有断点共用同一 TTL：
  1. 最后一个 `system` 块放 1 个断点（覆盖按名称排序的 `tools` + `system`）。
  2. 在扁平化后的消息内容块中最多放 3 个断点（`MESSAGE_CACHE_BREAKPOINTS = 3`），从最后一个可用块起每隔 `CACHE_BLOCK_STRIDE = 15` 个块向前标记。
  3. 断点绝不落在 `thinking` 或 `redacted_thinking` 块上（Anthropic 会以 HTTP 400 拒绝），遇到时自动回退到最近的可标记块。
  4. 对话中途插入的 `system` 消息原地转为 `<system-reminder>…</system-reminder>` 用户文本块，不提前提升至顶层 `system`，避免破坏已缓存前缀。

### 延迟加载工具（`claudeDeferTools`）

- **配置方式**：`claudeDeferTools` 接收非空且无首尾空白的字符串数组——每项为精确工具名或以 `*` 结尾的前缀模式（如 `mcp__*`，单个 `*` 匹配全部工具；不支持正则）。
- **满足的 Anthropic API 约束**：
  - 匹配 `claudeDeferTools`（或由 DSH 标记 `deferLoading: true`）的工具会附带 `defer_loading: true`。
  - 仅当至少有一个工具被延迟加载时，才在 `tools` 首位注入 Anthropic 服务端正则工具搜索工具（`type: "tool_search_tool_regex_20251119"`，`name: "tool_search_tool_regex"`）。由于搜索工具本身处于已加载状态，即使延迟所有其他工具也满足“不能全部工具都延迟”的 API 限制。
  - 若无工具匹配延迟规则，则保持 `tools` 数组原样且不注入搜索工具。
  - 绝不对延迟工具附加 `cache_control`（缓存标记留在 `system` 上），且工具列表始终按名称排序以稳定缓存前缀。

### 保留思考块与 `block_binding` Beta

- `adaptive` 与 `enabled` 两种思考模式均显式设置 `display: "summarized"`，确保思考摘要正常显示在界面“思考”面板中（`adaptive` 默认 `omitted`）。
- **前缀绑定回放**：`assembleAnthropicMessages` 为请求基准（`system` + 与顺序无关的 `tools`）、前置非思考消息块、响应正文以及前驱思考块签名/载荷计算 SHA-256 摘要。后续轮次仅在目标具体服务商、账号与模型完全一致且链条未断裂时回放带签名的 `thinking` 与 `redacted_thinking` 块。
- **拒绝回退与 `block_binding` Beta**：
  - 若 Anthropic 仍以 HTTP 400 拒绝回放的思考块（`Invalid signature/data in [redacted_]thinking block`），`ClaudeAdapter` 会自动去掉回放思考块重试一次，并记录 `reset: true` 屏障，后续不再重发该点之前的思考块。
  - 对使用自适应思考的 Claude 5.1+ 模型（`checksThinkingPrefix`），适配器会附加 `block_binding: { prefix_mismatch_behavior: "drop_block" }` 以及 `thinking-binding-controls-2026-08-01` Beta 请求头，在出现不可见前缀偏差时丢弃旧块而非直接 400 报错。

### 工具调用 ID 归一化与截图体积预算

- **工具调用 ID 归一化**：Messages API 要求 `tool_use.id` 与 `tool_result.tool_use_id` 符合 `^[a-zA-Z0-9_-]+$`。合规 ID 原样透传；跨服务商会话中的不合规 ID（例如 Codex 产生的 `call_…|fc_…`）会在请求侧确定性映射为 `<清洗前缀>_<16 字符 base64url sha256>`（≤ 64 字符且无碰撞），不改写持久化历史。合并后的用户消息中，所有 `tool_result` 块会自动归并到最前面。
- **图片尺寸限制与卸载预算**：
  - 单图限制（`CLAUDE_IMAGE_LIMIT`）：最长边 `2000` px、上限 `3,750,000` 字节（低于 Anthropic 5 MB base64 单图上限），超过 `softBytes: 1,000,000` 字节即触发重编码，避免大体积无损截图快速耗尽请求预算。
  - 单次请求内联图片总预算（`CLAUDE_REQUEST_IMAGE_BUDGET`）：`20 MiB` base64 数据（在 Anthropic 32 MB 请求体上限下留出约 12 MiB 给提示词、工具和文本）。在支持图片卸载的 DSH 0.2+ 宿主上，超出预算会抛出携带 `offloadImages` 的 `IMAGE_OFFLOAD_REQUIRED`，由宿主将最早的图片卸载为文本/路径引用后重试。

---

## Grok (X Premium / xAI)

### 认证与 OIDC 域名锁定

- **OIDC 发现**：从 `https://auth.x.ai/.well-known/openid-configuration` 获取授权与令牌端点（内存缓存）。`assertXaiEndpoint` 强制校验两个端点均为 `https:` 且主机名为 `x.ai` 或 `*.x.ai`，拒绝任何其他域名。
- **OAuth 流程**：使用客户端 ID `b1a00492-073a-47ea-816f-4c329264a828` 在 `127.0.0.1:56121/callback` 运行 PKCE 流程。换取令牌时同时回传 `code_verifier` 与 `code_challenge`（`S256`）；返回 HTTP 403 表示当前 X 套餐不含 API OAuth 权限。刷新令牌为表单提交，在过期前 2 分钟提前刷新。

### 端点、CLI 代理目录与计费查询

- **Responses 流式接口**：`https://api.x.ai/v1/responses`（`store: false`、`stream: true`、`prompt_cache_key: sessionId`）。无工具请求会省略 `tools`、`tool_choice`、`parallel_tool_calls`，规避 xAI 对无工具调用的 HTTP 400 校验错误。
- **双源模型目录**：
  - `https://api.x.ai/v1/models` 决定可用模型权威列表（自动过滤 `imagine`/`image-`/`video`/`embed` 等非对话模型）。
  - `https://cli-chat-proxy.grok.com/v1/models`（携带 `x-xai-token-auth: xai-grok-cli`）补充显示名、描述、按由弱到强排序的 `reasoning_efforts` + 默认 `reasoning_effort`，以及可选 `context_windows` 档位。若 CLI 代理不可达，会优雅降级并保留上次已知的元数据。
- **计费与用量**：`https://cli-chat-proxy.grok.com/v1/billing?format=credits`（携带 `x-xai-token-auth: xai-grok-cli`），同时兼容新版 `creditUsagePercent` + `currentPeriod` 与旧版以美分计价的 `monthlyLimit`/`used`。当响应未含 `subscriptionTier` 时，回退读取访问令牌 JWT 中的数字 `tier` 声明（`Free`、`SuperGrok`、`X Basic`、`X Premium`、`X Premium+`、`SuperGrok Heavy`、`SuperGrok Lite`、`SuperGrok Plus`）。
- **`context_windows` 档位**：当 CLI 目录为某模型广告了多个可选 `context_windows` 档位时，设置页提供按模型上下文窗口选择器（多账号池场景取交集），`GrokAdapter` 按所选值设置 `contextWindow`（默认回退 `256,000`）。

### 媒体与搜索工具

- **`x_search`**：以非流式方式调用 `https://api.x.ai/v1/responses`（`grok-4` + 内置 `x_search` 工具），支持最多 10 个 `allowed_x_handles` 或 `excluded_x_handles`（互斥）、日期范围及图片/视频理解开关。
- **`video_generate`**：向 `https://api.x.ai/v1/videos/generations` 提交 `grok-imagine-video-1.5` 任务（1–15 秒，支持画幅、分辨率与参考图 URL），每 3 秒轮询 `GET /v1/videos/{request_id}`（最长 10 分钟），完成后下载 MP4 至 `~/.dsh/plugins/subscriptions/videos/`。
- **`image_generate`**：通过 `https://api.x.ai/v1/images/{generations,edits}` 调用 `grok-imagine-image-2.0`（`response_format: "b64_json"`），在指定 `provider: "grok"` 或 Codex 未登录时生效，走[图片账号调度](./image-account-pool.zh.md)。
- 上述工具均可在 **设置 → 订阅 → Grok → 管理** 中按需开关（对新建会话生效）。

---

## GitHub Copilot

### 认证：两代令牌与实时 `Editor-Version`

- **设备流 + 令牌交换**：通过 GitHub OAuth 设备流（`https://github.com/login/device/code` 与 `/login/oauth/access_token`，VS Code Copilot Chat 客户端 ID `Iv1.b507a08c87ecfe98`，scope `read:user`）获取长期有效的 GitHub OAuth 令牌并存于 `refreshToken`。
- **短期 Copilot API 令牌**：每次刷新（过期前 5 分钟提前刷新或 401 重试）都会用 GitHub 令牌向 `https://api.github.com/copilot_internal/v2/token` 换取约 30 分钟有效的 Copilot API 令牌存入 `accessToken`（缺失 `expires_at` 时保守回退为 25 分钟）。换取接口返回 401/403 视为永久失效（令牌已撤销或订阅已过期）。
- **实时 VS Code `Editor-Version`**：Copilot 会对过旧的 `Editor-Version` 返回 `401 IDE token expired`。`latestVsCodeVersion` 会从 `https://update.code.visualstudio.com/api/releases/stable` 拉取最新稳定版本号（缓存 24 小时，离线回退 `1.107.0`），并在 401 重试时强制刷新后再重新换取令牌。含图片输入时附加 `copilot-vision-request: true`。

### 双协议路由、自动改道与手动 `wire` 锁定

- **按目录自动选路**：模型发现（`https://api.githubcopilot.com/models`）保留 `model_picker_enabled === true` 且 `policy.state !== "disabled"` 的模型，并记录 `supported_endpoints`：
  - 支持 `/chat/completions` 的模型默认走 `https://api.githubcopilot.com/chat/completions`（使用 `max_completion_tokens` 与 `stream_options: { include_usage: true }`）。
  - 仅列出 `/responses` 的模型（如较新的 GPT-5.5/5.6 系列）走 `https://api.githubcopilot.com/responses`（使用 `max_output_tokens` 与 `include: ["reasoning.encrypted_content"]`）。
- **工具 + 推理档位自动改道**：同时支持双协议、默认走 `/chat/completions` 的模型，当单次请求同时携带函数工具与非 `'none'` 的 `reasoningEffort` 时，`copilotRequestWire` 会自动改道至 `/responses`，避免 Copilot 在 `/chat/completions` 上返回 HTTP 400 `invalid_request_body`。
- **Responses 条目归一化与推理回放**：由于 Copilot 的 Responses 网关在每个 SSE 事件上都会生成新的不透明 `item.id`，`CopilotResponsesItemNormalizer` 基于 `output_index` 稳定条目标识（支持并行工具调用交错输出），并在适配器内存中按 `账号 × 会话 × 模型` 缓存已完成的加密推理条目（30 分钟空闲 TTL、单作用域上限 64 条、最多 32 个作用域，任意 Copilot 认证变更时清空），保证多轮工具链能回放推理上下文。
- **手动 `wire` 锁定**：在插件配置 `models.copilot` 条目中设置 `wire: "chat-completions"` 或 `wire: "responses"` 可覆盖目录推断（在使用静态 `models.copilot` 禁用在线发现时尤为关键）。
- **无用量端点**：GitHub Copilot 不提供订阅配额查询接口（`usage()` 返回 `{ supported: false }`），因此不进入用量看板（参见[用量追踪](./usage-tracking.zh.md)），在跨服务商账号池中紧迫度评分为 0（参见[账号池与限流机制](./pool-and-rate-limits.zh.md)）。

---

## Google Antigravity

### 默认禁用与手动启用风险提示

- **显式启用门控**：Google Antigravity **默认禁用**（`ProviderSettingsStore.providerEnabled('antigravity')` 返回 `false`，需在 **设置 → 订阅 → Google Antigravity → 手动启用** 中确认风险提示后才会开启）。
- **原因说明**：直连上游私有端点存在较高的账号封禁（ToS）风控，且上游目前会直接拦截 DSH 原生对话请求并返回 HTTP 429。本插件不合入规避客户端身份校验的改写，因此手动启用后目前实际仅可用于查看账号用量，无法正常进行模型对话。禁用状态下，本地已保存的账号凭据会原样保留，但路由、登录、后台目录刷新与用量查询均会被阻断。

### OAuth 客户端优先级与端点回退

- **OAuth 客户端解析优先级（`resolveAntigravityOAuthConfig`）**：
  1. 插件 YAML 配置：`antigravity.clientId`（及可选 `antigravity.clientSecret`）。
  2. 环境变量：`ANTIGRAVITY_CLIENT_ID`（及可选 `ANTIGRAVITY_CLIENT_SECRET`）。
  3. 内置公开 Antigravity 桌面 OAuth 客户端标识（`src/providers/antigravity-oauth-client.ts`）。
  - 仅配置密钥而不配置对应客户端 ID 会直接报错，确保自定义纯 PKCE 客户端不会误继承其他客户端的密钥。
  - 本地 PKCE 回调监听 `localhost:51121/oauth-callback`（端口被占时回退到随机端口），超时 5 分钟。
- **daily → production 回退**：`v1internal` 请求默认优先访问 `https://daily-cloudcode-pa.googleapis.com`，遇到传输故障或 HTTP `404`/`502`/`503`/`504` 时自动回退到 `https://cloudcode-pa.googleapis.com`。若显式配置了 `antigravity.baseURL`（必须是无路径、无查询参数、无片段、无凭据的 `https://` 源站），则严格锁定该单一源站不回退；`onboardUser` 也不会跨端点重复执行。
- **项目发现与激活**：登录时调用 `loadCodeAssist` 读取 `cloudaicompanionProject`；若尚未初始化且 `antigravity.onboard !== false`，则最多轮询 `onboardUser` 10 次（间隔 1 秒）。

### 模型分组（`agentModelSorts` 与 `tieredModelIds`）及配额

- **目录可见性与分组**：
  - `fetchAvailableModels` 以 `agentModelSorts` 作为原生选择器的可见清单，而非 `tieredModelIds`（后者包含 `pro`、`flashLite` 等纯类别路由），同时剔除 `tabModelIds`、`imageGenerationModelIds`、内部/禁用/不可选条目及非对话 ID。
  - `groupAntigravityModels` 将 `-low`、`-medium`、`-high`、`-xhigh` 变体合并为同一个模型分组并提供推理档位选择器（存在 `high` 时默认选 `high`，绝不凭空编造缺失档位，上下文与最大输出取各变体最小值），同时保留旧版具体模型 ID 的直接可调用性。
- **配额与用量（`retrieveUserQuotaSummary` + `loadCodeAssist`）**：
  - `fetchAntigravityUsage` 并行调用 `retrieveUserQuotaSummary`（获取共享配额分组）与 `loadCodeAssist`（获取套餐等级与 `availableCredits`）。
  - 当共享分组未能覆盖所有可选模型（如部分独立计费模型）时，补充读取 `fetchAvailableModels` 中的单模型 `quotaInfo`/`weeklyQuotaInfo`；若遇到认证错误、`ACCOUNT_SUSPENDED` 或 `RATE_LIMIT`，立即向上抛出而不发起多余的补充请求。

### 工具 Schema 转换与输出图片

- **工具 Schema 转换（`src/translate/antigravity-schema.ts`、`src/translate/antigravity.ts`）**：
  - 展开本地 `#/...` JSON Schema `$ref` 引用（拒绝循环引用与远程引用），并移除 `$schema`、`$id`、`$defs` 与 `definitions`。
  - Gemini 路由使用 `parametersJsonSchema`；Antigravity 下的 Claude 与 GPT-OSS 路由（`^(claude-|gpt-oss-)`）使用精简版 `parameters`，仅保留 `{type, description, properties, required, items, enum}`，合并 `allOf`、无损放宽 `anyOf`/`oneOf` 联合类型（不收窄合法调用），并清理可空类型数组。
  - 由于 Antigravity 的 `FunctionResponse.response` 映射到 protobuf `Struct`，非对象类型的 JSON 工具结果（如数组或标量）会自动包裹在 `{ output: ... }` 中。
- **输出图片**：Antigravity 的 `inlineData` 图片响应在 SSE 与 JSON 模式下都会持久化为 DSH 图片附件，详见[Antigravity 输出图片](./antigravity-output-images.zh.md)。
