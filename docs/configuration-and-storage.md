# Configuration and Local Storage

English | [中文](./configuration-and-storage.zh.md) · [Docs](./README.md) · [README](../README.md)

This reference covers the plugin YAML configuration schema, environment variables, and on-disk state stored under `~/.dsh/plugins/subscriptions/`.

For UI-managed account aliases, pool allowlists, and independent account model entries, see [Account and model management](./account-management.md). For pool scheduling and rate-limit behavior, see [Pool and rate limits](./pool-and-rate-limits.md).

## Plugin YAML Configuration

Configure the plugin under its entry in your DSH composition (`name: dsh-plugin-subscriptions`). All fields are validated by the Schemastery `Config` schema in `src/index.ts`.

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

### Top-Level Options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `providers` | `('codex' \| 'claude' \| 'grok' \| 'copilot' \| 'antigravity')[]` | All five | Subset of provider routes to register. Note: Antigravity also remains disabled by default until manually opted in via **Settings → Subscriptions** (`provider-settings.json`). |
| `codexClientVersion` | `string` | Auto (npm `@openai/codex` latest, fallback `0.153.4`) | Explicit `client_version` sent to the Codex `/models` catalog endpoint. When set, takes precedence and disables automatic npm lookup. Requires restarting DSH after change. |
| `streamIdleTimeoutMs` | `number` (≥ `1`) | `300000` (5 min) | Maximum provider idle time in milliseconds while a single stream read is outstanding. |
| `claudePromptCacheTtl` | `'5m' \| '1h'` | `'5m'` | Default Anthropic prompt-cache lifetime for Claude main conversations. Can be overridden without restart in **Settings → Subscriptions → Claude → Manage** (`provider-settings.json`). Compaction and session-title requests stay on `5m`. |
| `claudeDeferTools` | `string[]` | `[]` | Claude only. Literal tool names or trailing-`*` prefixes (for example `mcp__*`; not regular expressions) sent with `defer_loading: true` alongside Anthropic's server-side tool search tool (`tool_search_tool_regex_20251119`). Empty leaves requests unchanged. |

### `rateLimit` Options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `rateLimit.wait` | `boolean` | `true` | When `true`, routes allow `@deepseek-ai/dsh-llm-retry` to wait out a provider-disclosed rate-limit reset up to `maxWaitMs`. When `false`, only local exponential backoff applies. |
| `rateLimit.maxWaitMs` | `number` (`1` .. `2147483647`) | `21600000` (6 h) | Ceiling on a single rate-limit wait in milliseconds. Resets further out fail immediately with the reset time attached. Bounded by Node's maximum schedulable timer delay (`2,147,483,647` ms). |

### `models.<provider>` Options

Each provider (`codex`, `claude`, `grok`, `copilot`, `antigravity`) accepts an optional array of manual `ModelEntry` items. Supplying a non-empty list overrides live catalog discovery for that provider; an empty or omitted list keeps discovery/built-in defaults.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Wire model identifier. |
| `name` | `string` | No | Picker display name (defaults to `id`). |
| `contextWindow` | `integer` (≥ `1`) | No | Total context window capacity in tokens. |
| `maxTokens` | `integer` (≥ `1`) | No | Default maximum output tokens. |
| `inputModalities` | `('text' \| 'image')[]` | No | Supported input modalities. |
| `wire` | `'chat-completions' \| 'responses'` | No | **Copilot only.** Pins a manual model to `/chat/completions` or `/responses` (pinning `chat-completions` also opts out of automatic tools+effort rerouting to `/responses`). |

### `antigravity` Options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `antigravity.clientId` | `string` | Bundled desktop client | Custom Google OAuth client ID. Overrides `ANTIGRAVITY_CLIENT_ID` and the bundled client. |
| `antigravity.clientSecret` | `string` (secret) | Bundled desktop secret (only with bundled ID) | Optional Google OAuth client secret paired with `antigravity.clientId`. A custom client ID never inherits the bundled secret, and a secret without a matching ID from the same source is rejected. |
| `antigravity.baseURL` | `string` | Auto (`daily` → `prod` fallback) | Pins a single upstream origin instead of trying the daily endpoint with production fallback on transport/404/502/503/504 errors. |
| `antigravity.userAgent` | `string` | Built-in CLI user-agent | Overrides the `User-Agent` sent to Antigravity endpoints. |
| `antigravity.onboard` | `boolean` | `true` | Controls automatic Cloud AI Companion project onboarding during login. |

### `pool` Options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `pool.enabled` | `boolean` | `true` | Enables multi-account pooling (requires ≥2 accounts of a provider) and automatic `image_generate` account scheduling. |
| `pool.strategy` | `'priority' \| 'quota_aware' \| 'quota_normalized'` | `'quota_aware'` | Member selection strategy. See [Pool and rate limits](./pool-and-rate-limits.md). |
| `pool.switchMargin` | `number` (≥ `1`) | `2` | Hysteresis multiplier for `quota_aware` / `quota_normalized`: a challenger must out-score the sticky member by more than this factor to take over. |
| `pool.autoAccounts` | `boolean` | `true` | Automatically pool every discovered catalog model across eligible accounts of that provider (also controls `image_generate` account scheduling). |
| `pool.autoFamilies` | `boolean` | *(deprecated)* | Legacy alias for `pool.autoAccounts`. |
| `pool.families` | `Record<string, PoolMemberRef[]>` | `{}` | Explicit same-provider member lists keyed by catalog model ID, replacing automatic pooling for those models. Each member has `{ provider, model, account? }` (omitting `account` uses the default account). |
| `pool.tiers` | `Record<string, PoolMemberRef[]>` | `{}` | Optional extra picker rows with heterogeneous (cross-model or cross-provider) fallback lists, displayed under the first member's provider. |

## Environment Variables

| Variable | Scope | Behavior & Precedence |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude credential import | Directory where the plugin looks for Claude Code's `.credentials.json` file (defaults to `~/.claude`). On macOS, Keychain is also checked for Claude Code credentials. |
| `ANTIGRAVITY_CLIENT_ID` | Antigravity OAuth | Custom Google OAuth client ID. Precedence: `config.antigravity.clientId` → `ANTIGRAVITY_CLIENT_ID` → bundled desktop client. |
| `ANTIGRAVITY_CLIENT_SECRET` | Antigravity OAuth | Optional Google OAuth client secret paired with `ANTIGRAVITY_CLIENT_ID`. Never mixed with a client ID from another source. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | Host-managed proxy | Handled by DSH's global undici dispatcher when the plugin's own proxy override (`proxy.json`) is disabled or bypassed. Note that host environment variables are inherited by child commands, whereas credentials in `proxy.json` remain private to this plugin. |

## Local Data Layout

All persistent plugin state lives under `~/.dsh/plugins/subscriptions/` (resolved via `@deepseek-ai/dsh-home-paths`). JSON state files are written atomically via temp file + `rename` with mode `0600` (where applicable).

| Path | Mode | Contents | Safe to delete / reset? |
| --- | --- | --- | --- |
| `auth.json` | `0600` | OAuth access/refresh tokens, expiry timestamps, account keys, default-account pointers, and legacy key aliases for all five providers. On first read, if absent, automatically migrates and removes legacy `~/.dsh/plugins/router/auth.json`. | **Contains credentials.** Deleting logs out every subscription account. |
| `proxy.json` | `0600` | Optional plugin-scoped HTTP/HTTPS proxy URL, bypass list, and optional basic-auth username/password (the password is never returned to the browser). | **May contain proxy password.** Deleting disables the plugin proxy override and falls back to host routing. |
| `provider-settings.json` | `0600` | UI-managed provider settings: provider/model display names, account aliases, pool participation and `poolModels` allowlists, independent account entries, visible model lists, Codex/Grok context window overrides, Codex subagent speed defaults, Claude `promptCacheTtl` override, Antigravity opt-in `enabled` flag, and creation-time `toolHistory`. | Safe to reset if you want default UI preferences; note that deleting also resets Antigravity to disabled and clears custom tool/account preferences. |
| `model-defaults.json` | `0600` | Per-provider, per-model default reasoning effort overrides saved from **Edit model list**. | Safe to delete; models revert to following provider defaults. |
| `model-speeds.json` | `0600` | Last remembered Codex composer Speed choice (`standard` / `fast`) per underlying model. | Safe to delete; composer speed resets to `standard`. |
| `models.json` | default | Cached discovered model catalogs (default and non-default accounts) with capability metadata (`reasoning`, `contextWindow`, etc.). | **Cache only.** Safe to delete; repopulated on the next catalog discovery. |
| `usage/` | `0600` files | Per-provider aggregate token counts, quota cycle metadata (`meta.json`, `open.json`, `closed-YYYY.jsonl`, `pre-tracking.json`), and transient `.lock` files. Never stores prompts, credentials, or per-request logs. See [Usage tracking](./usage-tracking.md). | Safe to delete (or clear via **Clear history** in the Usage Dashboard); removes only local usage statistics. |
| `images/` | default | Generated and edited images saved by `image_generate`. | Safe to prune; older conversation references to deleted files will no longer load. |
| `videos/` | default | Generated MP4 clips saved by `video_generate`. | Safe to prune; older conversation clips referencing deleted files will no longer play. |
