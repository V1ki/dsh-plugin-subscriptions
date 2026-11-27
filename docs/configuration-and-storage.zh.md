# 配置与本地存储

[English](./configuration-and-storage.md) | 中文 · [文档索引](./README.zh.md) · [README](../README.zh.md)

本文档说明插件的 YAML 配置 Schema、环境变量，以及存储在 `~/.dsh/plugins/subscriptions/` 下的全部本地数据文件。

界面中管理的账号别名、账号池模型白名单与独立账号模型入口，请参阅[账号与模型管理](./account-management.zh.md)。账号池调度与限流策略，请参阅[模型池、付费额度兜底与限流处理](./pool-and-rate-limits.zh.md)。

## 插件 YAML 配置

在 DSH 编排配置中的插件条目下配置本插件（`name: dsh-plugin-subscriptions`）。所有字段均由 `src/index.ts` 中的 Schemastery `Config` Schema 校验。

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude, grok, copilot, antigravity]
    # codexClientVersion: '0.153.4'
    streamIdleTimeoutMs: 300000
    claudePromptCacheTtl: 5m
    claudeDeferTools: []
    rateLimit:
      wait: true
      maxWaitMs: 21600000
    # models:
    #   codex:
    #     - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
    #   copilot:
    #     - { id: gpt-5.6-sol, wire: responses }
    # antigravity:
    #   clientId: '...'
    #   clientSecret: '...'
    #   baseURL: 'https://daily-cloudcode-pa.googleapis.com'
    #   userAgent: '...'
    #   onboard: true
    pool:
      enabled: true
      strategy: quota_aware
      switchMargin: 2
      autoAccounts: true
      # families: {}
      # tiers: {}
```

### 顶层配置项

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `providers` | `('codex' \| 'claude' \| 'grok' \| 'copilot' \| 'antigravity')[]` | 全部五个 | 要注册的 provider 路由子集。注意：Antigravity 默认仍处于禁用状态，需在 **设置 → 订阅** 中手动确认启用（保存于 `provider-settings.json`）。 |
| `codexClientVersion` | `string` | 自动查询（npm `@openai/codex` 最新稳定版，兜底 `0.153.4`） | 显式指定发送给 Codex `/models` 目录接口的 `client_version`。配置后优先使用该值并关闭自动 npm 查询；修改后需重启 DSH 生效。 |
| `streamIdleTimeoutMs` | `number`（≥ `1`） | `300000`（5 分钟） | 单次流式读取等待期间允许的最长空闲时间（毫秒）。 |
| `claudePromptCacheTtl` | `'5m' \| '1h'` | `'5m'` | Claude 主对话的默认 Anthropic 提示缓存时长。可在 **设置 → 订阅 → Claude → 管理** 中免重启覆盖（保存于 `provider-settings.json`）。压缩（compaction）与会话标题请求固定保持 `5m`。 |
| `claudeDeferTools` | `string[]` | `[]` | 仅 Claude 生效。要以 `defer_loading: true` 发送的工具字面名称或带单个结尾 `*` 的前缀（例如 `mcp__*`，不支持正则表达式），并自动附带 Anthropic 服务端工具搜索工具（`tool_search_tool_regex_20251119`）。为空时请求体保持不变。 |

### `rateLimit` 配置项

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `rateLimit.wait` | `boolean` | `true` | 为 `true` 时，允许 `@deepseek-ai/dsh-llm-retry` 等待服务商披露的限流窗口重置（上限为 `maxWaitMs`）；为 `false` 时仅执行本地指数退避。 |
| `rateLimit.maxWaitMs` | `number`（`1` .. `2147483647`） | `21600000`（6 小时） | 单次等待限流窗口重置的上限（毫秒）。重置时间超过该上限时会立即失败并附带重置时刻。最大值受 Node 定时器上限（`2,147,483,647` ms）约束。 |

### `models.<provider>` 配置项

每个 provider（`codex`、`claude`、`grok`、`copilot`、`antigravity`）均支持可选的手动 `ModelEntry` 数组。配置非空列表时会覆盖该 provider 的在线目录发现；留空或省略时保持在线发现/内置默认目录。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 上游 wire 模型 ID。 |
| `name` | `string` | 否 | 模型选择器中的显示名（默认使用 `id`）。 |
| `contextWindow` | `integer`（≥ `1`） | 否 | 总上下文窗口容量（token 数）。 |
| `maxTokens` | `integer`（≥ `1`） | 否 | 默认最大输出 token 数。 |
| `inputModalities` | `('text' \| 'image')[]` | 否 | 支持的输入模态列表。 |
| `wire` | `'chat-completions' \| 'responses'` | 否 | **仅 Copilot 生效。** 将手动配置的模型固定到 `/chat/completions` 或 `/responses`（固定为 `chat-completions` 也会关闭 tools+effort 自动改道至 `/responses`）。 |

### `antigravity` 配置项

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `antigravity.clientId` | `string` | 内置桌面客户端 | 自定义 Google OAuth Client ID，优先级高于 `ANTIGRAVITY_CLIENT_ID` 与内置默认值。 |
| `antigravity.clientSecret` | `string`（secret） | 内置桌面密钥（仅配合内置 ID） | 与 `antigravity.clientId` 配对的可选 Google OAuth Client Secret。自定义 Client ID 不会继承内置密钥；没有同源配对 ID 的单独密钥会被拒绝。 |
| `antigravity.baseURL` | `string` | 自动（`daily` → `prod` 回退） | 固定单一上游源地址，关闭从 daily 端点在传输错误或 404/502/503/504 时回退到 production 端点的行为。 |
| `antigravity.userAgent` | `string` | 内置 CLI User-Agent | 覆盖发送给 Antigravity 端点的 `User-Agent`。 |
| `antigravity.onboard` | `boolean` | `true` | 控制登录期间是否自动执行 Cloud AI Companion 项目初始化（onboarding）。 |

### `pool` 配置项

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `pool.enabled` | `boolean` | `true` | 启用多账号模型池（需同一 provider 登录 ≥2 个账号）以及 `image_generate` 的自动账号调度。 |
| `pool.strategy` | `'priority' \| 'quota_aware' \| 'quota_normalized'` | `'quota_aware'` | 成员选择策略，详见[模型池、付费额度兜底与限流处理](./pool-and-rate-limits.zh.md)。 |
| `pool.switchMargin` | `number`（≥ `1`） | `2` | `quota_aware` / `quota_normalized` 的滞后切换倍率：挑战者得分必须严格超过粘性成员得分的该倍数才会接管。 |
| `pool.autoAccounts` | `boolean` | `true` | 自动将每个目录模型池化到该 provider 所有符合条件的已登录账号上（同时控制 `image_generate` 的自动账号调度）。 |
| `pool.autoFamilies` | `boolean` | *（已弃用）* | `pool.autoAccounts` 的历史兼容别名。 |
| `pool.families` | `Record<string, PoolMemberRef[]>` | `{}` | 按目录模型 ID 显式指定同 provider 成员列表，替换该模型的自动账号池。每项包含 `{ provider, model, account? }`（省略 `account` 表示默认账号）。 |
| `pool.tiers` | `Record<string, PoolMemberRef[]>` | `{}` | 可选的额外模型选择器条目，支持异构（跨模型或跨 provider）回退列表，显示在首个成员所属 provider 分组下。 |

## 环境变量

| 变量名 | 适用范围 | 行为与优先级 |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude 凭据导入 | 指定插件查找 Claude Code `.credentials.json` 的目录（默认 `~/.claude`）。在 macOS 上还会同时检查 Keychain 中的 Claude Code 凭据。 |
| `ANTIGRAVITY_CLIENT_ID` | Antigravity OAuth | 自定义 Google OAuth Client ID。优先级：`config.antigravity.clientId` → `ANTIGRAVITY_CLIENT_ID` → 内置桌面客户端。 |
| `ANTIGRAVITY_CLIENT_SECRET` | Antigravity OAuth | 与 `ANTIGRAVITY_CLIENT_ID` 配对的可选 Google OAuth Client Secret，不会与其他来源的 Client ID 混用。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | 宿主统一代理 | 当插件自带代理（`proxy.json`）关闭或命中绕过列表时，由 DSH 的全局 undici dispatcher 接管。注意：宿主环境变量会被子命令继承，而 `proxy.json` 中的代理凭据仅限本插件私有。 |

## 本地数据目录布局

插件的所有持久化数据均位于 `~/.dsh/plugins/subscriptions/`（通过 `@deepseek-ai/dsh-home-paths` 解析）。JSON 状态文件采用临时文件 + `rename` 的原子写入方式，敏感文件权限为 `0600`。

| 路径 | 权限 | 内容说明 | 是否可安全删除 / 重置 |
| --- | --- | --- | --- |
| `auth.json` | `0600` | 五个 provider 的 OAuth access/refresh token、过期时间、账号 key、默认账号指针与历史 key 别名。首次读取若文件不存在，会自动迁移并删除更名前的 `~/.dsh/plugins/router/auth.json`。 | **包含登录凭据。** 删除将导致所有订阅账号退出登录。 |
| `proxy.json` | `0600` | 可选的插件级 HTTP/HTTPS 代理地址、绕过列表以及可选的 Basic Auth 用户名/密码（密码永不回传给浏览器）。 | **可能包含代理密码。** 删除后会关闭插件代理并回退至宿主网络路由。 |
| `provider-settings.json` | `0600` | 界面中保存的 provider 设置：服务商与模型显示名、账号别名、账号池参与开关与 `poolModels` 白名单、独立账号模型入口、可见模型列表、Codex/Grok 上下文窗口覆盖、Codex 子代理默认速度、Claude `promptCacheTtl` 覆盖、Antigravity 手动启用开关 `enabled`，以及按会话创建时间生效的 `toolHistory`。 | 可安全重置以恢复默认界面偏好；注意删除会将 Antigravity 重置为默认禁用，并清空自定义工具与账号设置。 |
| `model-defaults.json` | `0600` | 在 **编辑模型列表** 中为各 provider 模型保存的默认推理强度覆盖。 | 可安全删除；模型恢复为跟随服务商默认推理强度。 |
| `model-speeds.json` | `0600` | 按底层模型记住的 Codex 输入框上次速度选择（`standard` / `fast`）。 | 可安全删除；输入框速度重置为 `standard`。 |
| `models.json` | 默认 | 已发现模型目录（含默认与非默认账号）及其能力元数据（`reasoning`、`contextWindow` 等）的本地缓存。 | **纯缓存文件。** 可安全删除，下次目录发现时自动重建。 |
| `usage/` | 文件 `0600` | 按 provider 存放的聚合 token 计数、额度周期元数据（`meta.json`、`open.json`、`closed-YYYY.jsonl`、`pre-tracking.json`）及临时 `.lock` 锁文件。绝不存储提示词、凭据或逐请求日志，详见[用量统计、额度周期与缓存语义](./usage-tracking.zh.md)。 | 可安全删除（或在用量看板中点击 **清空历史**）；仅清除本地用量统计。 |
| `images/` | 默认 | `image_generate` 生成与编辑后保存的图片文件。 | 可按需清理；历史对话中引用已删除文件的图片将无法再加载。 |
| `videos/` | 默认 | `video_generate` 生成并保存的 MP4 视频文件。 | 可按需清理；历史对话中引用已删除文件的视频将无法再播放。 |
