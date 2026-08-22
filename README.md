# dsh-plugin-subscriptions

English | [中文](README.zh.md)

Use your **ChatGPT (Codex)**, **Claude**, and **Grok (X Premium)** subscriptions as LLM providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no API keys. Codex and Grok log in via OAuth in the dsh web UI (Settings → Subscriptions); Claude imports credentials from an existing Claude Code session when there is one (macOS Keychain or `~/.claude/.credentials.json`) and otherwise falls back to the same browser OAuth flow, so the Claude Code CLI is not required. Tokens live at `~/.dsh/plugins/subscriptions/auth.json` (mode 0600) and refresh automatically.

## Demo

Settings → **Subscriptions**: per-provider login/logout, no API keys. Claude imports credentials from Claude Code when available and otherwise uses OAuth, as Codex and Grok always do (account address masked in the screenshot):

![Subscriptions settings page](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

Logged-in providers join the session model picker with their live model catalogs:

![Model picker with subscription models](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

Models that advertise reasoning levels get an **Effort** selector in the same menu — Codex models, and Grok 4.6 / 4.5 (levels and defaults come from each provider's live catalog, not a hardcoded list):

![Reasoning effort selector](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

Codex models whose catalog advertises the fast tier (the codex CLI's fast mode) get a **Speed** toggle in the composer's tool row, next to the model selector — Standard or Fast (`service_tier: priority`), per session. The `/fast` slash command offers the same choice as a popup; it errors with an explanation when the current model has no fast tier.

![Speed toggle with the Standard/Fast menu open](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

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

Only logged-in providers appear in the session model picker; the lists above refresh on login/logout. Vision-capable models declare `['text', 'image']` input modalities, and image content is translated to each provider's wire format.

Logged-in cards also show **subscription usage** — per rate-limit window (5-hour session, weekly, and per-model weekly where the plan has one) with the used percentage, a progress bar, and the reset time, plus a Refresh button. Codex usage comes from `chatgpt.com/backend-api/wham/usage` (also reports the plan), Claude usage from `api.anthropic.com/api/oauth/usage`, and Grok usage from the Grok Build CLI proxy's `cli-chat-proxy.grok.com/v1/billing` (the source of the CLI's `/usage` panel; reports the shared weekly pool and the subscription tier).

Also included, registered when the matching provider is enabled:

- **`x_search`** tool (Grok) — xAI's hosted X search, returning `{ answer, citations }`.
- **`image_generate`** tool (ChatGPT or Grok) — `gpt-image-2` via the Codex backend, or `grok-imagine-image-2.0` via `api.x.ai/v1/images/generations`. The `provider` argument picks the preferred provider (`gpt`, the default, or `grok`); when the preferred one is logged out the other serves as fallback. Images are saved under `~/.dsh/plugins/subscriptions/images/` and the paths returned. The `size`/`quality` arguments map onto Grok's `aspect_ratio`/`quality` on the Grok path.
- **`video_generate`** tool (Grok) — `grok-imagine-video-1.5` via `api.x.ai/v1/videos` (async submit + poll); MP4s are saved under `~/.dsh/plugins/subscriptions/videos/`, the path returned, and the clip plays inline in the conversation. Supports duration (1–15 s), aspect ratio, resolution, and image-to-video via `image_url`.

## Install

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
2. Settings → **Subscriptions**: click **Connect** on a provider. For Claude, credentials are imported instantly if you have run `claude` and logged in at least once; without them, Claude authorizes in the browser like the others. For Codex and Grok, authorize in the opened browser tab; if the browser flow can't complete (headless host), expand the manual fallback and paste the callback URL or code.
3. In any session, open the model picker (`/model`) and choose a model under **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)**.

Not logged in? The provider stays out of the picker, and requests fail with `MISSING_CREDENTIAL` pointing at the Settings page; nothing else breaks.

## Config

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude]        # subset; default all three
    streamIdleTimeoutMs: 300000
    rateLimit:
      wait: true                       # wait out a closed rate-limit window (default)
      maxWaitMs: 21600000              # ceiling on one wait; 6 h, covers a 5-hour session window
    models:                            # override the discovered/built-in catalogs
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
```

### Waiting out a rate-limit window

A subscription plan is rate-limit shaped by design — a 5-hour session window, a weekly one, and on some plans a per-model weekly one — so a 429 is not a dead end: the window reopens at a time the provider discloses. Each route reads that reset off its own 429 and reports it as the wait to take.

Only a signal that names the window which actually rejected the request is waited on: Anthropic's `anthropic-ratelimit-unified-reset`, the seconds Codex puts on a `usage_limit_reached` rejection, the delay xAI names in the error body, or a plain `retry-after`. The per-bucket rollover snapshots (`anthropic-ratelimit-{requests,tokens,…}-reset`, `x-codex-*-reset-after-seconds`, `x-ratelimit-reset-*`) ride every response and cannot say which bucket refused — the earliest is usually one that still had room — so a 429 carrying nothing else is logged through the plugin's warning sink, naming the headers and the head of the body, rather than parking the turn on a guess.

Reading is confined to a 429. Every other failure keeps its short local backoff: those same headers ride a transient 500 too, and honouring them there would hold a turn for the rest of the window over an overload that clears in a second.

Waiting itself is executed by [`@deepseek-ai/dsh-llm-retry`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm-retry), which every route's retry policy is written for: add it to the composition, or nothing waits and a closed window fails the turn as before.

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
```

A reset further out than `maxWaitMs` — a weekly window days away — fails the turn immediately rather than parking the session. `wait: false` drops back to local backoff alone.

All three routes share Claude Code's own retry shape: ten retries after the first attempt, backing off from 1 s with 20% jitter under a 60 s cap. These are consumer subscription endpoints that shed load in bursts, and the dsh-llm defaults (five retries from 500 ms to 10 s) give up after about fifteen seconds, which is short for that. A 429 that discloses no reset is now retried locally for roughly 17 minutes before the turn fails — about 5 minutes with `wait: false`, where the 60 s cap actually binds.

One trade-off worth knowing: the delay ceiling is shared with that local backoff, so raising `maxWaitMs` also raises how long an unrelated transient failure (`TRANSPORT`, `SERVER`, `TIMEOUT`) can back off for before the finite retry budget runs out — up to 512 s on the last of the ten retries instead of the 60 s cap.

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
- `src/providers/` — per-provider OAuth constants/exchange/refresh + `LlmAdapter`s, and `rate-limit.ts` (reset-instant parsing + retry policy)
- `src/translate/` — dsh `Message[]` ⟷ OpenAI Responses / Anthropic Messages wire formats, SSE → `StreamChunk`
- `src/tools/` — `x_search`, `image_generate`, and `video_generate`
- `src/client/` — the Settings → Subscriptions page (browser half, zh/en, theme-token aware)
