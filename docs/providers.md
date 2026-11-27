# Providers

[中文](./providers.zh.md) · [Documentation](./README.md)

Per-provider authentication, upstream endpoints, wire quirks, and advanced options for `dsh-plugin-subscriptions`. For YAML config keys and local storage paths, see [Configuration and storage](./configuration-and-storage.md); for multi-account failover and cooldowns, see [Pool and rate limits](./pool-and-rate-limits.md).

---

## ChatGPT (Codex)

### Auth and account identity

- **OAuth flow**: Authorization Code + PKCE against `https://auth.openai.com/oauth/authorize` and `https://auth.openai.com/oauth/token` using the official Codex CLI client ID (`app_EMoamEEZ73f0CkXaXp7hrann`), listening on `localhost` ports `1455` or `1457` (`/auth/callback`).
- **Token refresh**: Code exchange is `application/x-www-form-urlencoded`; refresh is JSON (`grant_type: "refresh_token"`), preempting 5 minutes before expiry. Permanent refresh codes (`refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`, `invalid_grant`) remove the stored session and require re-login.
- **Workspace + user account keys**: Stored sessions key on a JSON tuple `[chatgpt_account_id, "user", chatgpt_user_id]` (falling back to `[chatgpt_account_id, "email", email]` or bare `accountId` for legacy unidentified sessions) so multiple users inside the same ChatGPT Team/Enterprise workspace stay distinct. Legacy workspace-only keys migrate in place and keep recorded aliases (`src/auth/store.ts`).

### Endpoints and catalog version lookup

- **Responses stream**: `https://chatgpt.com/backend-api/codex/responses` (stream-only, `store: false`, `include: ["reasoning.encrypted_content"]`, `prompt_cache_key: sessionId`, deterministic `session-id` header).
- **Model catalog**: `https://chatgpt.com/backend-api/codex/models?client_version=<version>`. Hidden entries (`visibility` of `hide` or `none`) are dropped and results are sorted by `priority`.
- **Automatic `client_version` lookup**: Because the backend gates visible models on `client_version`, `CodexClientVersionCache` lazily queries `https://registry.npmjs.org/@openai%2fcodex/latest` (unauthenticated, 5s timeout, 6h success TTL / 5m failure TTL, floored at bundled `0.153.4`, never downgrading). Setting `codexClientVersion` in plugin config overrides the lookup.
- **Happy Eyeballs connect timeout floor**: On startup, `src/http.ts` raises Node's `net.autoSelectFamilyAttemptTimeout` to at least `1500` ms (`MIN_CONNECT_ATTEMPT_TIMEOUT_MS`, restored on plugin dispose) so dual-stack TCP handshakes to Cloudflare-fronted hosts (`registry.npmjs.org`, `chatgpt.com`) do not fail at Node's 250 ms default on higher-latency links.

### Context capping, effort, speed, and wire repair

- **Context window capping**: Built-in fallbacks are `400,000` tokens (`CODEX_CONTEXT_WINDOW`) and `8,192` local output reserve (`CODEX_DEFAULT_MAX_TOKENS`, a DSH local budgeting reservation, not an API response cap). Per-model (`contextWindows`) and Codex-wide (`contextWindow`, `defaultMaxTokens`) Settings overrides are always capped at the serving account's reported `max_context_window` (or discovered `context_window` when no separate maximum is advertised).
- **Fast mode and subagent default speed**: Models advertising `service_tiers` ID `"priority"` (or legacy `additional_speed_tiers` `"fast"`) enable the composer Speed toggle, sending `service_tier: "priority"` when `fast` is active and omitting `service_tier` for `standard`. Main-session per-model choices persist in `model-speeds.json`. Subagent sessions (`origin === "subagent"`) follow per-model `subagentSpeeds` in `provider-settings.json` (default `standard`), independent of the main session's Speed toggle.
- **`ultra` → `max` effort lowering**: Codex's `ultra` is a client-only mode rejected with HTTP 400 by the Responses API. Catalog discovery filters `ultra` out, and `codexWireEffort` lowers any previously saved `ultra` value to `max` at the wire boundary.
- **Tool-call ID normalization and pairing**: `normalizeCodexCallIds` leaves IDs ≤ 64 characters verbatim and deterministically hashes longer IDs to `call_<sha256>` (reserving all existing short IDs first). `reconcileResponsesToolCalls` injects a synthetic unknown-outcome `function_call_output` for unmatched calls and drops orphan outputs at request time without mutating durable history.

### Usage, purchased credits, reset cards, and tools

- **Usage (`wham/usage`)**: `https://chatgpt.com/backend-api/wham/usage` returns rate-limit windows and credit info without consuming quota. Windows are classified by `limit_window_seconds` (±5% around 5h session / 7d weekly, falling back to slot order only when duration is absent) because the backend sometimes reports the weekly lane in `primary_window`.
- **Purchased credits**: `wham/usage` `credits` (`balance`, `unlimited`, `has_credits`, `overage_limit_reached`) are surfaced in Settings and the status badge. Non-positive numeric balances (`<= 0`) are hidden in the UI; positive balances enable last-resort credit-funded pool routing (see [Pool and rate limits](pool-and-rate-limits.md)).
- **Manual reset cards**: Reads available `codex_rate_limits` cards from `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` and redeems them only on explicit user confirmation via `/consume`. Guardrails (`src/providers/reset-redemption.ts`): requires ≥ 80% fresh weekly usage, issues a 60-second single-use confirmation ticket, locks the account as `uncertain` if submission fails ambiguously, and notifies the usage tracker on confirmed redemption.
- **`web_search` and `image_generate` tools**:
  - Registers `CodexWebSearchProvider` behind DSH's native `web_search` capability (`ctx.web`) using `https://chatgpt.com/backend-api/codex/alpha/search` (`gpt-5.6-terra`, up to 5 transport/5xx attempts, 2 MiB response limit). Disabling Codex `web_search` in Settings flips `available()` to `false`, releasing the seam to another registered search provider instead of denying the host's tool.
  - Backs `image_generate` (`gpt-image-2` via `/backend-api/codex/images/{generations,edits}`, preferred default over Grok) using [Image account scheduling](image-account-pool.md).

---

## Claude (Anthropic)

### Auth: Keychain sync vs standalone OAuth

- **Claude Code credential sync**: Clicking Log in first checks Claude Code's native credential store — macOS Keychain item `Claude Code-credentials`, falling back to `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`. Imported accounts are marked `keychainBound: true`.
  - A background timer runs every 5 minutes for bound accounts, and refreshes go through `refreshClaudeSynced`: it reads Claude Code's store first to pick up tokens rotated externally by the `claude` CLI, and writes its own rotated tokens back to the store (`writeBackClaudeCodeCredentials`) so both tools stay in sync.
- **Standalone browser OAuth**: Choosing the browser flow (or logging in when no Claude Code credentials exist) runs PKCE OAuth against `https://claude.ai/oauth/authorize` and `https://claude.ai/v1/oauth/token` on an ephemeral `localhost` port (`/callback`). Standalone accounts leave `keychainBound` unset and refresh independently (5-minute preempt) so multiple Claude accounts never contend over a single Keychain entry.

### Endpoints and CLI identity

- **Messages API**: `https://api.anthropic.com/v1/messages?beta=true` (`anthropic-version: 2023-06-01`, `x-app: cli`, `anthropic-dangerous-direct-browser-access: true`). Every request prepends the required Claude Code identity block as the first `system` entry.
- **Models and usage**: `https://api.anthropic.com/v1/models?beta=true` (reads `max_input_tokens`, `max_tokens`, thinking types `enabled`/`adaptive`, and advertised effort levels) and `https://api.anthropic.com/api/oauth/usage` (reads both the modern `limits` array and legacy `five_hour`/`seven_day*` buckets).
- **CLI version presentation**: Sends `User-Agent: claude-cli/<version> (external, cli)` resolved by `ClaudeCliVersionCache` from `https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest`, floored at the newer of local `claude --version` and bundled `2.1.283`.

### Prompt caching (`claudePromptCacheTtl`)

- **TTL modes**: `'5m'` (default — sends `{ type: "ephemeral" }` without `ttl`; writes cost 1.25× base input) or `'1h'` (sends `{ type: "ephemeral", ttl: "1h" }`; writes cost 2× base input). Cache reads cost the same under both TTLs.
- **Precedence & UI override**: Configured in YAML via `claudePromptCacheTtl`, and overridable live without restart in **Settings → Subscriptions → Claude → Manage → Prompt cache lifetime** (`provider-settings.json` `promptCacheTtl`). Auxiliary requests carrying a `purpose` (compaction, session titles) always use `5m`.
- **Breakpoint placement**: Anthropic allows at most 4 cache breakpoints per request and rejects a `1h` mark after a `5m` mark, so all marks in a request share one TTL:
  1. One mark on the last `system` block (covering name-sorted `tools` + `system`).
  2. Up to 3 marks across the flattened message content blocks (`MESSAGE_CACHE_BREAKPOINTS = 3`), placed at the last eligible block and every `CACHE_BLOCK_STRIDE = 15` blocks backwards.
  3. Marks never land on `thinking` or `redacted_thinking` blocks (which Anthropic rejects with HTTP 400); they step back to the nearest eligible block.
  4. Mid-conversation `system` messages stay in place wrapped as `<system-reminder>…</system-reminder>` user text blocks rather than being hoisted into `system`, preserving the cached prefix.

### Deferred tools (`claudeDeferTools`)

- **Configuration**: `claudeDeferTools` accepts an array of non-empty strings without surrounding whitespace — each a literal tool name or a literal prefix ending in `*` (e.g. `mcp__*`; bare `*` matches all tools; regular expressions are not interpreted).
- **API rules satisfied**:
  - Tools matching `claudeDeferTools` (or marked `deferLoading: true` by DSH) are emitted with `defer_loading: true`.
  - When at least one tool is deferred, the adapter prepends Anthropic's server-side regex tool search tool (`type: "tool_search_tool_regex_20251119"`, `name: "tool_search_tool_regex"`). Because the search tool itself is a loaded tool, deferring every other tool satisfies Anthropic's requirement that not all tools be deferred.
  - When no tool is deferred, the `tools` array is unchanged and no search tool is added.
  - `cache_control` is never attached to deferred tools (the cache mark stays on `system`), and tool definitions remain sorted by name for stable cache prefixes.

### Preserved extended thinking and `block_binding`

- Both `adaptive` and `enabled` thinking modes explicitly set `display: "summarized"` so reasoning text is returned for the UI Think panel (adaptive models otherwise default to `omitted`).
- **Prefix-bound replay**: `assembleAnthropicMessages` records SHA-256 digests of the request base (`system` + order-independent `tools`), prior non-thinking message blocks, response content, and predecessor thinking signature/payload. On subsequent turns, signed `thinking` and `redacted_thinking` blocks replay only to the same concrete provider, account, and model when an unbroken valid chain matches.
- **Refusal fallback & `block_binding` beta**:
  - If Anthropic still rejects a replayed thinking block with HTTP 400 (`Invalid signature/data in [redacted_]thinking block`), `ClaudeAdapter` retries once without replayed thinking and records a `reset: true` barrier so earlier thinking is not resent.
  - For Claude 5.1+ models using adaptive thinking (`checksThinkingPrefix`), the adapter adds `block_binding: { prefix_mismatch_behavior: "drop_block" }` alongside the `thinking-binding-controls-2026-08-01` beta header so unseen prefix mismatches drop the stale block instead of failing with HTTP 400.

### Tool-call ID normalization and screenshot image budget

- **Tool-call ID normalization**: The Messages API requires `tool_use.id` and `tool_result.tool_use_id` to match `^[a-zA-Z0-9_-]+$`. Compliant IDs pass verbatim; non-compliant IDs from cross-provider sessions (such as Codex's `call_…|fc_…`) are deterministically rewritten per request to `<sanitized_stem>_<16-char base64url sha256>` (≤ 64 chars, collision-free) without modifying stored history. Leading `tool_result` blocks in merged user messages are grouped ahead of other content blocks.
- **Image limits & offload budget**:
  - Per-image cap (`CLAUDE_IMAGE_LIMIT`): `maxEdge: 2000` px, `maxBytes: 3,750,000` bytes (under Anthropic's 5 MB base64 per-image ceiling), with `softBytes: 1,000,000` bytes triggering re-encoding so lossless screenshots do not quickly exhaust the request budget.
  - Per-request inline image budget (`CLAUDE_REQUEST_IMAGE_BUDGET`): `20 MiB` of base64 image data (leaving ~12 MiB under Anthropic's 32 MB body limit for prompts, tools, and text). On DSH 0.2+ hosts supporting image offload, exceeding this budget throws `IMAGE_OFFLOAD_REQUIRED` with `offloadImages` so the host offloads the oldest images to text/file paths and retries.

---

## Grok (X Premium / xAI)

### Auth and OIDC domain pinning

- **OIDC discovery**: Resolves authorization and token endpoints from `https://auth.x.ai/.well-known/openid-configuration` (cached in memory). `assertXaiEndpoint` pins both discovered URLs to `https:` on `x.ai` or `*.x.ai`, rejecting any other host.
- **OAuth flow**: PKCE on `127.0.0.1:56121/callback` using client ID `b1a00492-073a-47ea-816f-4c329264a828`. The authorization-code exchange echoes both `code_verifier` and `code_challenge` (`S256`); an HTTP 403 indicates the X plan lacks API OAuth entitlement. Token refresh is form-encoded and preempts 2 minutes before expiry.

### Endpoints, CLI proxy catalog, and billing

- **Responses stream**: `https://api.x.ai/v1/responses` (`store: false`, `stream: true`, `prompt_cache_key: sessionId`). Tool fields (`tools`, `tool_choice`, `parallel_tool_calls`) are omitted when no tools are provided to avoid xAI HTTP 400 errors on tool-less requests.
- **Dual-source model discovery**:
  - `https://api.x.ai/v1/models` is authoritative for available model IDs (non-chat `imagine`/`image-`/`video`/`embed` IDs are filtered out).
  - `https://cli-chat-proxy.grok.com/v1/models` (with header `x-xai-token-auth: xai-grok-cli`) enriches models with display names, descriptions, `reasoning_efforts` (sorted weakest-to-strongest, with top-level `reasoning_effort` as default), and selectable `context_windows` tiers. If the CLI proxy is unreachable, discovery degrades gracefully and preserves last-known metadata.
- **Billing / usage**: `https://cli-chat-proxy.grok.com/v1/billing?format=credits` (with `x-xai-token-auth: xai-grok-cli`). Reads the modern `creditUsagePercent` + `currentPeriod` shape or the legacy cent-denominated `monthlyLimit`/`used` shape. When `subscriptionTier` is omitted, the plan label falls back to the access token's numeric `tier` JWT claim (`Free`, `SuperGrok`, `X Basic`, `X Premium`, `X Premium+`, `SuperGrok Heavy`, `SuperGrok Lite`, `SuperGrok Plus`).
- **`context_windows` tiers**: When the CLI catalog exposes multiple `context_windows` tiers for a model, Settings offers a per-model context-window picker (intersecting options across logged-in accounts when pooled), and `GrokAdapter` bounds `contextWindow` accordingly (default fallback: `256,000`).

### Media and search tools

- **`x_search`**: Non-streaming `https://api.x.ai/v1/responses` call on `grok-4` with the built-in `x_search` tool; supports up to 10 `allowed_x_handles` or `excluded_x_handles` (mutually exclusive), date ranges, and image/video understanding flags.
- **`video_generate`**: Submits `grok-imagine-video-1.5` jobs to `https://api.x.ai/v1/videos/generations` (1–15 s duration, optional aspect ratio / resolution / image URL), polls `GET /v1/videos/{request_id}` every 3 seconds (up to 10 minutes), and downloads the resulting MP4 into `~/.dsh/plugins/subscriptions/videos/`.
- **`image_generate`**: Calls `grok-imagine-image-2.0` via `https://api.x.ai/v1/images/{generations,edits}` (`response_format: "b64_json"`) as `provider: "grok"` or fallback when Codex is logged out, scheduled through [Image account scheduling](image-account-pool.md).
- Each tool can be toggled on/off in Settings → Subscriptions → Grok → Manage (changes apply to newly created sessions).

---

## GitHub Copilot

### Auth: two-generation tokens and live `Editor-Version`

- **Device flow + token exchange**: Uses GitHub's OAuth device flow (`https://github.com/login/device/code` and `/login/oauth/access_token`, VS Code Copilot Chat client ID `Iv1.b507a08c87ecfe98`, scope `read:user`) to obtain a long-lived GitHub OAuth token stored in `refreshToken`.
- **Short-lived Copilot API token**: Before requests (5-minute preempt) or on HTTP 401, the adapter exchanges the GitHub token at `https://api.github.com/copilot_internal/v2/token` for a ~30-minute Copilot API token stored in `accessToken` (25-minute conservative fallback if `expires_at` is omitted). A 401/403 from the exchange is treated as permanent (revoked GitHub token or lost Copilot subscription).
- **Live VS Code `Editor-Version`**: Copilot rejects outdated `Editor-Version` headers with `401 IDE token expired`. `latestVsCodeVersion` fetches `https://update.code.visualstudio.com/api/releases/stable` (24-hour cache, pinned fallback `1.107.0`) and force-refreshes it on any 401 retry before re-exchanging the token. Vision requests include `copilot-vision-request: true`.

### Dual-wire protocol, auto-reroute, and manual `wire` pin

- **Catalog-driven wire selection**: Discovery (`https://api.githubcopilot.com/models`) keeps entries where `model_picker_enabled === true` and `policy.state !== "disabled"`, recording `supported_endpoints`:
  - Models listing `/chat/completions` default to `https://api.githubcopilot.com/chat/completions` (`max_completion_tokens`, `stream_options: { include_usage: true }`).
  - Models listing only `/responses` (such as newer GPT-5.5/5.6 families) use `https://api.githubcopilot.com/responses` (`max_output_tokens`, `include: ["reasoning.encrypted_content"]`).
- **Tools + effort auto-reroute**: Dual-protocol models that default to `/chat/completions` automatically reroute a single request to `/responses` when the request combines function tools with any `reasoningEffort` other than `'none'` (`copilotRequestWire`), avoiding Copilot's HTTP 400 `invalid_request_body` on `/chat/completions`.
- **Responses item normalization and reasoning replay**: Because Copilot's Responses gateway mints a fresh opaque `item.id` on every SSE event, `CopilotResponsesItemNormalizer` stabilizes item identity via `output_index` (preserving interleaved parallel tool calls) and captures completed encrypted reasoning items in adapter memory (scoped per `account × conversation × model`, 30-minute idle TTL, 64 calls / 32 scopes caps, cleared on any Copilot auth change) so tool-call chains replay their reasoning.
- **Manual `wire` pin**: Setting `wire: "chat-completions"` or `wire: "responses"` on an entry in `models.copilot` overrides catalog inference (useful when static `models.copilot` config disables live discovery).
- **No usage endpoint**: GitHub Copilot does not expose a subscription quota endpoint (`usage()` returns `{ supported: false }`). It is excluded from the Usage Dashboard (see [Usage tracking](usage-tracking.md)) and scores zero urgency in multi-provider pools (see [Pool and rate limits](pool-and-rate-limits.md)).

---

## Google Antigravity

### Disabled by default (opt-in risk notice)

- **Opt-in gate**: Google Antigravity is **disabled by default** (`ProviderSettingsStore.providerEnabled('antigravity')` returns `false` until enabled in **Settings → Subscriptions → Google Antigravity → Enable manually** with explicit risk confirmation).
- **Why**: Direct access to upstream private endpoints carries a high risk of account suspension (ToS), and upstream currently rejects native DSH chat requests with HTTP 429. Because this plugin does not ship client-identity workarounds, manually enabling Antigravity is currently limited to inspecting account usage rather than running chat models. While disabled, saved local accounts are preserved untouched while routes, logins, background catalog refreshes, and usage calls are blocked.

### OAuth client precedence and endpoint fallback

- **OAuth client resolution (`resolveAntigravityOAuthConfig`)**:
  1. Plugin YAML config: `antigravity.clientId` (+ optional `antigravity.clientSecret`).
  2. Environment variables: `ANTIGRAVITY_CLIENT_ID` (+ optional `ANTIGRAVITY_CLIENT_SECRET`).
  3. Bundled public Antigravity desktop OAuth client (`src/providers/antigravity-oauth-client.ts`).
  - Specifying a secret without its matching client ID throws an error so a custom PKCE-only client never inherits another client's secret.
  - Loopback PKCE listens on `localhost:51121/oauth-callback` (falling back to an ephemeral port) with a 5-minute timeout.
- **Daily → production fallback**: `v1internal` requests target `https://daily-cloudcode-pa.googleapis.com` first and fall back to `https://cloudcode-pa.googleapis.com` on transport failures or HTTP `404`/`502`/`503`/`504`. Setting `antigravity.baseURL` (must be an `https://` origin with no path, query, fragment, or credentials) pins that single origin without fallback; `onboardUser` also never repeats across endpoints.
- **Project discovery & onboarding**: Login calls `loadCodeAssist` to read `cloudaicompanionProject`. If none exists and `antigravity.onboard !== false`, it polls `onboardUser` up to 10 times (1 s apart).

### Model grouping (`agentModelSorts` vs `tieredModelIds`) and quota

- **Catalog visibility & grouping**:
  - `fetchAvailableModels` treats `agentModelSorts` — not `tieredModelIds`, which contains category-only routes such as `pro` and `flashLite` — as the native picker inventory, while excluding `tabModelIds`, `imageGenerationModelIds`, internal/disabled/non-selectable entries, and non-chat IDs.
  - `groupAntigravityModels` merges `-low`, `-medium`, `-high`, and `-xhigh` variants into a single model family with a reasoning-effort picker (defaulting to `high` when present, never inventing missing tiers, taking the minimum `contextWindow`/`maxOutputTokens` across variants). Legacy concrete IDs remain directly callable.
- **Usage & quota (`retrieveUserQuotaSummary` + `loadCodeAssist`)**:
  - `fetchAntigravityUsage` fetches shared quota windows from `retrieveUserQuotaSummary` and plan/credit info from `loadCodeAssist` in parallel.
  - When shared quota groups do not cover every selectable model (for example, model-specific lanes), it supplements from `fetchAvailableModels`'s per-model `quotaInfo`/`weeklyQuotaInfo`. Auth, `ACCOUNT_SUSPENDED`, and `RATE_LIMIT` errors propagate immediately without extra supplemental calls.

### Tool-schema translation and output images

- **Tool-schema translation (`src/translate/antigravity-schema.ts`, `src/translate/antigravity.ts`)**:
  - Resolves local `#/...` JSON Schema `$ref` pointers (rejecting cycles and remote references) and strips `$schema`, `$id`, `$defs`, and `definitions`.
  - Gemini routes receive `parametersJsonSchema`; Claude and GPT-OSS routes behind Antigravity (`^(claude-|gpt-oss-)`) receive legacy `parameters` reduced to `{type, description, properties, required, items, enum}` by merging `allOf`, widening `anyOf`/`oneOf` unions without narrowing valid calls, and stripping nullable array types.
  - Non-object JSON tool results (arrays or primitives) are wrapped in `{ output: ... }` because Antigravity's `FunctionResponse.response` maps to a protobuf `Struct`.
- **Output images**: Antigravity `inlineData` image responses are stored as durable DSH image attachments across both SSE and JSON transports; see [Antigravity output images](antigravity-output-images.md).
