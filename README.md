# dsh-plugin-subscriptions [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Use your **ChatGPT (Codex)**, **Claude**, **Grok (X Premium)**, **GitHub Copilot**, and **Google Antigravity** subscriptions as LLM providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no API keys. Codex, Grok, and Antigravity log in via OAuth in the dsh web UI (Settings → Subscriptions), while Copilot uses the GitHub OAuth device flow; Claude imports credentials from an existing Claude Code session when there is one (macOS Keychain or `~/.claude/.credentials.json`) and otherwise falls back to the same browser OAuth flow, so the Claude Code CLI is not required. Tokens live at `~/.dsh/plugins/subscriptions/auth.json` (mode 0600) and refresh automatically.

## Demo

Settings → **Subscriptions**: per-provider login/logout, no API keys. Claude imports credentials from Claude Code when available and otherwise uses OAuth, as Codex and Grok always do (settings screenshots use demo accounts and catalog data):

![Subscriptions settings page](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

Configure visibility, default reasoning effort, and context together in **Edit model list**, with shared Save and Cancel actions:

![Model settings](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-settings.png)

Configure image generation, video generation, and X search per provider. Tool switches apply only to sessions created after saving:

![Provider tools](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/provider-tools.png)

Logged-in providers join the session model picker with their live model catalogs:

![Model picker with subscription models](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

Models that advertise reasoning levels get an **Effort** selector in the same menu — Codex models, Grok 4.6 / 4.5, and Copilot's reasoning models (levels and defaults come from each provider's live catalog, not a hardcoded list; Copilot's `capabilities.supports.reasoning_effort` array is sent as `reasoning_effort` on chat completions and `reasoning.effort` on the Responses wire). Models listing both Copilot endpoints (gpt-5.4, gpt-5-mini) normally speak chat completions but reroute to `/responses` when a request combines function tools with an effort — Copilot rejects that combination on the chat wire:

![Reasoning effort selector](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

Codex models whose catalog advertises the fast tier (the codex CLI's fast mode) get a **Speed** toggle in the composer's tool row, next to the model selector — Standard or Fast (`service_tier: priority`), per session. The `/fast` slash command offers the same choice as a popup; it errors with an explanation when the current model has no fast tier.

![Speed toggle with the Standard/Fast menu open](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

The composer's stats row gains a **subscription usage** pill showing the remaining rate-limit window for the provider of the session's current model (Codex when a GPT model is selected, Grok for a Grok model, and so on). Click it to expand every logged-in provider and account — the default account is starred, and the current provider is listed first:

![Subscription usage pill expanded to show every provider and account](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/usage-badge.png)

The `image_generate` tool renders its result inline in the conversation:

![image_generate renders the image inline](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-inline.png)

Its `provider` parameter picks the image backend — the same prompt through GPT (`gpt-image-2`, top) and Grok (`grok-imagine-image-2.0`, bottom):

![image_generate with provider gpt vs grok](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-providers.png)

The `video_generate` tool plays the generated clip inline:

![video_generate plays the clip inline](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/video-generate-inline.png)

## Providers

| Route    | Subscription      | Models |
|----------|-------------------|--------|
| `codex`  | ChatGPT Plus/Pro  | live catalog from `chatgpt.com/backend-api/codex/models` |
| `claude` | Claude Pro/Max    | all models available in your subscription (Opus, Sonnet, Haiku, Fable — static catalog, updated with the plugin) |
| `grok`   | X Premium (xAI)   | live catalog from `api.x.ai/v1/models` (chat models only); reasoning efforts from the Grok CLI catalog (`cli-chat-proxy.grok.com/v1/models`) |
| `copilot` | GitHub Copilot   | live catalog from `api.githubcopilot.com/models` (chat models on both wires, with per-model vision flags and reasoning efforts); login uses the OAuth device flow (enter the shown code at `github.com/login/device`) |
| `antigravity` | Google Antigravity | live catalog from Antigravity `v1internal:fetchAvailableModels`; requests use `generateContent` / `streamGenerateContent` with text, image, streaming reasoning, and tool-call conversion |

Only logged-in providers appear in the session model picker; the lists above refresh on login/logout. Vision-capable models declare `['text', 'image']` input modalities, and image content is translated to each provider's wire format.

Logged-in cards also show **subscription usage** — per rate-limit window (5-hour session, weekly, and per-model weekly where the plan has one) with the used percentage, a progress bar, and the reset time, plus a Refresh button. Codex usage comes from `chatgpt.com/backend-api/wham/usage` (also reports the plan), Claude usage from `api.anthropic.com/api/oauth/usage`, and Grok usage from the Grok Build CLI proxy's `cli-chat-proxy.grok.com/v1/billing` (the source of the CLI's `/usage` panel; reports the shared weekly pool and the subscription tier). Antigravity reports plan, credits, and per-model quotas from `loadCodeAssist` and `fetchAvailableModels` when those fields are present. Copilot exposes no usage endpoint, so its card shows no usage section.

Also included, registered when the matching provider is enabled:

- **`web_search`** provider (Codex) — uses Codex's hosted web search through DSH's native tool and citation UI. It follows the default Codex account and the plugin's proxy configuration.
- **`x_search`** tool (Grok) — xAI's hosted X search, returning `{ answer, citations }`.
- **`image_generate`** tool (ChatGPT or Grok) — `gpt-image-2` via the Codex backend, or `grok-imagine-image-2.0` via `api.x.ai/v1/images/generations`. The `provider` argument picks the preferred provider (`gpt`, the default, or `grok`); when the preferred one is logged out the other serves as fallback. Images are saved under `~/.dsh/plugins/subscriptions/images/` and the paths returned. The `size`/`quality` arguments map onto Grok's `aspect_ratio`/`quality` on the Grok path.
- **`video_generate`** tool (Grok) — `grok-imagine-video-1.5` via `api.x.ai/v1/videos` (async submit + poll); MP4s are saved under `~/.dsh/plugins/subscriptions/videos/`, the path returned, and the clip plays inline in the conversation. Supports duration (1–15 s), aspect ratio, resolution, and image-to-video via `image_url`.

`image_generate` also supports editing: the model passes optional `referenceImages` (1–5 complete DSH attachment references) to edit or use existing images as sources; omitting it keeps text-to-image generation. References can come from uploads, `read_image`, or previous generated images. Read local files with `read_image` first; paths are not attachment references. Copy references from the image reference text or structured tool results. Their order matches the prompt's image order. Edits save new files and return reusable references, including for subsequent edits with another provider.

Codex edits use `/backend-api/codex/images/edits`; Grok edits use `/v1/images/edits`. Existing provider preference, logged-out fallback, and session tool policy still apply. Empty arrays, duplicate or invalid references, and attachment-limit violations fail explicitly instead of generating a new image. Editing requires the DSH attachment service.


Image generation and editing share same-provider account scheduling: try the default account first, then prefer the successful account in that session. Explicit quota, authentication, or image-entitlement rejection tries the remaining accounts; a 401 gets at most one credential refresh and retry first. Image-only cooldowns honor provider reset times and clear on login/logout. Transport failures, timeouts, 5xx responses, and invalid requests do not automatically resend, avoiding duplicate images. Set `pool.enabled: false` or `pool.autoAccounts: false` (legacy `autoFamilies` is accepted) to use only the default account. Image scheduling does not use chat catalogs, chat quota scoring, `families`, or `tiers`.

## Install

### Refreshing model lists

In **Settings → Subscriptions → provider → Edit model list**, use **Refresh** to bypass the five-minute catalog cache and refresh the conversation model picker too. This is separate from refreshing subscription usage. If `models.<provider>` is explicitly configured with a non-empty list, that list still overrides discovery.

Codex catalog visibility depends on the `client_version` request parameter. By default the plugin reads the stable version from the official npm `@openai/codex` package's public metadata (no CLI installation or subscription credentials sent to npm). Successful lookups are cached in memory for six hours; failures retry after five minutes and retain the last successful version, or the verified `0.153.4` fallback on first use. The lookup has a 1.5-second deadline, shares in-flight work across accounts, and ignores prerelease or regressed versions. Manual model-list refresh also rechecks the version. An explicit plugin configuration field, `codexClientVersion: '0.153.4'`, takes precedence and disables automatic lookup; restart DSH after changing it. Model availability remains account-dependent; see [verification notes](docs/codex-catalog-refresh.md).

### Installation commands

With the `dsh` CLI available, install from npm (prebuilt artifacts, no build permission needed):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

Or install the sources from GitHub:

```sh
dsh plugin --profile web add github:V1ki/dsh-plugin-subscriptions
```

pnpm will ask you to allow this package's build script on first install (git installs fetch sources, not built artifacts); add the printed key to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

and re-run the `add`. Only grant this to packages you trust — it runs the package's code at install time.

From a local checkout instead:

```sh
git clone https://github.com/V1ki/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

Headless-only usage without installing into a profile (log in via the web UI first — the token file is shared):

```sh
cp overlay.example.yml overlay.yml   # then edit the name: to this checkout's absolute lib/index.js path
dsh --profile headless --patch <checkout>/overlay.yml "your task"
```

## Update

Installed from npm:

```sh
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

Installed from GitHub: re-run the same `add github:V1ki/dsh-plugin-subscriptions` command — it re-fetches the sources and rebuilds. A linked local checkout just needs `git pull && pnpm build` in the checkout.

Either way, restart `dsh web` afterwards so the new version loads.

## Use

1. `dsh web`, open the printed URL.
2. Settings → **Subscriptions**: click **Connect** on a provider. For Claude, credentials are imported instantly if you have run `claude` and logged in at least once; without them, Claude authorizes in the browser like the others. For Codex, Grok, and Antigravity, authorize in the opened browser tab; Copilot shows a GitHub device code to enter at `github.com/login/device`; if a browser flow can't complete (headless host), expand the manual fallback and paste the callback URL or code.
3. In any session, open the model picker (`/model`) and choose a model under **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)** / **GitHub Copilot** / **Google Antigravity**.

Not logged in? The provider stays out of the picker, and requests fail with `MISSING_CREDENTIAL` pointing at the Settings page; nothing else breaks.

### Multiple accounts

Every provider accepts several accounts: once one is connected, the card grows an **Add account** button (Claude offers **Browser authorization** and **Import Claude Code** separately). Accounts are keyed by their identity (email / login) — re-logging the same account updates it in place, a different account appends. Browser authorization signs in whichever account the browser currently uses, so switch accounts there first (or use an incognito window with the manual code) to add a different one. The ★ default account serves the direct provider routes; pool routes use every account. A Claude account imported from Claude Code stays synced with the CLI's credential store; OAuth-added Claude accounts refresh standalone so several accounts never fight over the Keychain entry.

### Edit visible models, context windows, and tools

Open **Settings → Subscriptions → provider → Edit model list**, search and select models, then **Save changes**. All discovered models are shown automatically by default. Selecting individual models, selecting all, or clearing the selection saves an explicit list; newly discovered models then stay hidden until selected. Enable automatic display again to restore discovery-driven visibility. Hidden models remain usable by existing sessions, and the editor retains the full catalog so they can be restored. Refreshing discovery preserves preferences; Cancel discards unsaved edits.

Codex models also accept a context budget in tokens; leave it blank to follow the provider. The plugin reads each account's `context_window` and `max_context_window`, caps the requested budget at that account's maximum, and uses the advertised default as the conservative ceiling when no maximum is provided. Account pools resolve each member separately and use the smallest window. This changes DSH's local history budget and compaction timing, without sending an API capacity override. Longer contexts can increase response latency.

The same editor controls Codex Web Search and image generation, plus Grok image generation, video generation, and X search. Changes apply only to sessions created after saving; existing sessions retain their creation-time policy, including after restart. Image generation is shared: it disappears only when neither configured provider enables it, and execution never falls back to a provider disabled for that session. Claude and Copilot currently have no standalone subscription tools to configure.

Preferences and tool-policy history live in `~/.dsh/plugins/subscriptions/provider-settings.json` (mode 0600), independently of the five-minute discovery cache. Existing non-empty `models.<provider>` configuration still defines the base catalog; visibility selections filter that catalog.

### Reasoning defaults in the model editor

Default reasoning effort now lives in **Edit model list**, beside each model's visibility and context settings. Apply edits with **Save changes**, or discard unsaved edits with Cancel. Hidden models remain editable. Models without reasoning levels have no selector; **Follow provider** clears an override. Choices come from live capabilities, intersected across account-pool members. Custom pool aliases do not offer ineffective effort overrides.

Existing defaults continue to load from and save to `~/.dsh/plugins/subscriptions/model-defaults.json` (mode 0600). If a save fails partway through, unfinished edits remain in the draft; the UI reports any defaults already saved and lets you retry.

## Config

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude]        # subset; default all five
    streamIdleTimeoutMs: 300000
    rateLimit:
      wait: true                       # wait out a closed rate-limit window (default)
      maxWaitMs: 21600000              # ceiling on one wait; 6 h, covers a 5-hour session window
    models:                            # override the discovered/built-in catalogs
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
      copilot:                         # manual entries disable Copilot catalog discovery
        - { id: gpt-5.6-sol, wire: responses }   # copilot only: force the upstream protocol
```

`wire` (copilot entries only) pins a model to `chat-completions` or `responses`. Manual
entries keep working without it — the field exists because a configured model the live
catalog does not know would otherwise default to `/chat/completions`, which
responses-only families (gpt-5.5/5.6, …) reject. Pinning `chat-completions` also opts
out of the tools+effort auto-reroute described above.

Antigravity includes the public desktop OAuth client identity used by [pi-antigravity](https://github.com/Rahularya01/pi-antigravity/blob/697858cafcf1faddf2ae898d2f053b2ff26c05e6/SECURITY.md#oauth-client-credentials), so **Log in** opens Google authorization without additional client configuration. To use your own client, configure `antigravity.clientId` and its optional `antigravity.clientSecret`, or set `ANTIGRAVITY_CLIENT_ID` and its optional `ANTIGRAVITY_CLIENT_SECRET`. Priority is plugin configuration, environment, then the bundled default. Each source supplies its own client pair; a custom client ID never inherits the default secret, and a secret without a matching ID is rejected. Optional `antigravity.baseURL`, `antigravity.userAgent`, and `antigravity.onboard` configure its endpoint, client identity, and account initialization. This route uses Antigravity OAuth and the v1internal project envelope, independently of Gemini CLI.

Antigravity converts Gemini tools to `parametersJsonSchema` and Claude/GPT-OSS tools to the supported `parameters` subset, resolving local schema references without modifying the DSH tool registry. Unresolved/cyclic references and custom-tool unions that cannot be represented fail before the request. Known runtime families expose their reasoning efforts in model settings and use model-specific thinking budgets; signed text, reasoning, and tool calls are replayed only to the same provider/model. Compatibility mapping is based on [pi-antigravity](https://github.com/Rahularya01/pi-antigravity/tree/697858cafcf1faddf2ae898d2f053b2ff26c05e6); offline tests do not verify account eligibility or live API acceptance.

Without `antigravity.baseURL`, generation and catalog/project reads try the daily endpoint, then production on a transport failure or HTTP 404/502/503/504, before returning any stream content. Explicit origins stay pinned. HTTP 400/401/403/429 and cancelled requests do not trigger endpoint fallback; onboarding is never repeated across endpoints.

## Model pools

When a provider has **two or more logged-in accounts**, the picker shows the **union** of every account's catalog (duplicates dropped). Pick `claude-sonnet-5` under Claude (or `gpt-5.4` under ChatGPT) as usual — there is no extra pool group and no new model id.

- **Shared models.** A model listed by ≥2 accounts failovers between them (sticky, quota-aware). Each account is discovered separately, so a Plus login is not asked to serve a Pro-only model.
- **Account-only models.** A model listed by only one account is sent to that account. It still appears in the picker even if that account is not the default.
- **Explicit account lists (`families`).** Replace the auto member list for one catalog model (same provider only; cross-provider members are ignored). Pin `account` or omit it for the default.
- **Tier extras (`tiers`, optional).** Extra picker rows with heterogeneous fallbacks, listed under the first member's provider. Not created automatically.

Selection is sticky per session (prompt caches survive) with two strategies: `priority` (first healthy member wins) and `quota_aware` (the default — each member is scored by its required burn rate, `remaining quota / time until window reset`, so a window about to reset with plenty left gets spent instead of wasted; the sticky member holds until a challenger out-scores it by `switchMargin`). Members past 95% on any usage window are gated out; failures fail over before the first stream chunk with cooldowns (`retry-after`, or the window's own disclosed reset when the provider sends one) — quota and rate-limit failures cool the whole account down (its quota is account-level; Claude's model-scoped lanes cool per member), transient server failures cool only the failing member. Copilot exposes no usage telemetry, so it scores zero and naturally serves as the fallback of last resort.

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    pool:
      enabled: true                   # default; needs ≥2 accounts of one provider
      strategy: quota_aware           # or priority
      switchMargin: 2                 # hysteresis factor for quota_aware
      autoAccounts: true              # pool each catalog model across that provider's accounts
      families:                       # explicit account list for one catalog model (same provider)
        claude-sonnet-5:
          - { provider: claude, model: claude-sonnet-5 }                   # default account
          - { provider: claude, account: bob@example.com, model: claude-sonnet-5 }
      tiers:                          # optional extra picker rows
        smart:
          - { provider: claude, model: claude-sonnet-5 }
          - { provider: codex, model: gpt-5.6-sol }
          - { provider: grok, model: grok-4.6 }
```

### Waiting out a rate-limit window

A subscription plan is rate-limit shaped by design — a 5-hour session window, a weekly one, and on some plans a per-model weekly one — so a 429 is not a dead end: the window reopens at a time the provider discloses. Each route reads that reset off its own 429 and turns it into that account's pool cooldown (see Model pools above) instead of a fixed 5-minute guess.

Only a signal that names the window which actually rejected the request is read: Anthropic's `anthropic-ratelimit-unified-reset`, the seconds Codex puts on a `usage_limit_reached` rejection, the delay xAI names in the error body, or a plain `retry-after`. The per-bucket rollover snapshots (`anthropic-ratelimit-{requests,tokens,…}-reset`, `x-codex-*-reset-after-seconds`, `x-ratelimit-reset-*`) ride every response and cannot say which bucket refused — the earliest is usually one that still had room — so a 429 carrying nothing else is logged through the plugin's warning sink, naming the headers and the head of the body, rather than parking the turn (or the pool cooldown) on a guess.

Reading is confined to a 429. Every other failure keeps its short local backoff: those same headers ride a transient 500 too, and honouring them there would hold a turn for the rest of the window over an overload that clears in a second.

With a pool, this is what actually does the waiting: a 429'd account is parked until its own disclosed reset and the request fails over to another account of the same provider immediately — no wait, no lost turn. Only once **every** account (the whole pool) is cooling down does the adapter report a `RATE_LIMIT` carrying the pool's *earliest* reset as the wait to take. With a single account (no pool, or a provider with only one login), that same disclosed reset is reported directly.

Waiting on that reported delay is executed by [`@deepseek-ai/dsh-llm-retry`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm-retry), which every route's retry policy is written for: add it to the composition, or nothing waits and a closed window fails the turn as before (falling back to whichever other pool accounts are healthy, if any).

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
```

```yaml
- name: dsh-plugin-subscriptions
  config:
    rateLimit:
      wait: true            # default; false keeps the previous seconds-scale behaviour
      maxWaitMs: 21600000   # 6 h — covers a 5-hour session window with slack
```

A reset further out than `maxWaitMs` — a weekly window days away, or a whole pool cooling down past it — fails the turn immediately with the reset time attached, rather than parking the session for days. `wait: false` drops back to local backoff alone.

All five routes share Claude Code's own retry shape: ten retries after the first attempt, backing off from 1 s with 20% jitter under a 60 s cap. These are consumer subscription endpoints that shed load in bursts, and the dsh-llm defaults (five retries from 500 ms to 10 s) give up after about fifteen seconds, which is short for that. A 429 that discloses no reset is now retried locally for roughly 17 minutes before the turn fails — about 5 minutes with `wait: false`, where the 60 s cap actually binds. Copilot currently uses the generic `retry-after` signal; unrecognized GitHub rate-limit headers are surfaced through the plugin warning sink for a future provider-specific reader.

One trade-off worth knowing: the delay ceiling is shared with that local backoff, so raising `maxWaitMs` also raises how long an unrelated transient failure (`TRANSPORT`, `SERVER`, `TIMEOUT`) can back off for before the finite retry budget runs out — up to 512 s on the last of the ten retries instead of the 60 s cap.

## Proxy

DSH `v0.1.3-alpha.1` introduces host-managed proxy routing. Prefer configuring `HTTP_PROXY` / `HTTPS_PROXY` (or `ALL_PROXY`) and `NO_PROXY` in the launch environment or `$DSH_HOME/.env`, then restart DSH and **disable the plugin proxy**. See the [DSH network proxy guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/docs/user/guide/network-proxy.md). Proxy credentials in environment variables are inherited by child commands; this differs from keeping them in the plugin's private config. Existing settings are not deleted or migrated automatically.

The optional plugin override remains available for supported older DSH hosts and subscription-only routing. Every subscription request — token exchanges, model-API streams, usage lookups, model discovery, and the `web_search` / `x_search` / `image_generate` / `video_generate` tools — can use it. Configure it in **Settings → Subscriptions → Proxy → Configure…**: enable the flag, enter the proxy URL (`http://127.0.0.1:7890`), optional username/password, and an optional comma-separated bypass list (`127.0.0.1`, `localhost`, `*.example.com`). Disabled or bypassed requests use DSH's global fetch routing, **not necessarily a direct connection**; use the host's `NO_PROXY` when direct routing is required. The password is stored in `~/.dsh/plugins/subscriptions/proxy.json` (mode 0600) and is never returned to the browser. A "Test" button probes one endpoint through the current configuration and shows the HTTP status/latency.

Changes apply immediately to subsequent requests — no restart needed. The OAuth authorization page opens in your browser and follows the browser/system proxy, not this setting. SOCKS proxies are not supported.

## Related plugins

This plugin only supplies model routes. Approval policy lives elsewhere:

- [`dsh-plugin-auto-review`](https://github.com/delef/dsh-plugin-auto-review) — provider-native automatic review for DSH tool approvals. It reproduces Codex Guardian and Grok escalation logic on top of the `codex` / `grok` routes registered here (or compatible routes from other DSH LLM adapters) via `ctx.llm.stream()`, and does not touch accounts or credentials. Install with `dsh plugin --profile web add dsh-plugin-auto-review`.

## Develop

```sh
pnpm install   # devDependencies link into a local deepseek-harness checkout — edit the paths first
pnpm build     # tsc (lib/) + tsdown (lib/client.js browser bundle)
pnpm test      # node --test over compiled unit specs
```

`prepare` (used by git installs) runs `tsdown.prepare.config.ts`: a self-contained bundle build of both faces with all `@deepseek-ai/*` specifiers external — they resolve from the dsh installation at runtime, so this package never carries a second cordis copy.

After `pnpm build`, restart `dsh web` to pick up changes.

## Layout

- `src/index.ts` — plugin entry: config schema, adapter registration, auth-change re-announce, RPC wiring
- `src/auth/` — PKCE/JWT helpers, token store, OAuth flow engine (temp loopback callback server), Claude Code credential reader (Keychain/file), `/subscriptions-auth` RPC channel
- `src/providers/` — per-provider OAuth constants/exchange/refresh + `LlmAdapter`s, multi-account token plumbing (`accounts.ts`), the pool (`pool.ts` + `pool-health.ts` / `pool-usage.ts` / `pool-family.ts`), and `rate-limit.ts` (reset-instant parsing + retry policy)
- `src/translate/` — dsh `Message[]` ⟷ OpenAI Responses / Anthropic Messages / Antigravity wire formats, SSE → `StreamChunk`
- `src/providers/codex-search.ts` — Codex provider for DSH's native `web_search` capability
- `src/tools/` — `x_search`, `image_generate`, and `video_generate`
- `src/client/` — the Settings → Subscriptions page (browser half, zh/en, theme-token aware)
