# dsh-plugin-subscriptions [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Use your **ChatGPT (Codex)**, **Claude**, and **Grok (X Premium)** subscriptions as LLM providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no API keys. Codex and Grok log in via OAuth in the dsh web UI (Settings → Subscriptions); Claude imports credentials from an existing Claude Code session when there is one (macOS Keychain or `~/.claude/.credentials.json`) and otherwise falls back to the same browser OAuth flow, so the Claude Code CLI is not required. Tokens live at `~/.dsh/plugins/subscriptions/auth.json` (mode 0600) and refresh automatically.

## Demo

Settings → **Subscriptions**: per-provider login/logout, no API keys. Claude imports credentials from Claude Code when available and otherwise uses OAuth, as Codex and Grok always do (account address masked in the screenshot):

![Subscriptions settings page](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

Logged-in providers join the session model picker with their live model catalogs:

![Model picker with subscription models](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

Models that advertise reasoning levels get an **Effort** selector in the same menu — Codex models, Grok 4.6 / 4.5, and Copilot's reasoning models (levels and defaults come from each provider's live catalog, not a hardcoded list; Copilot's `capabilities.supports.reasoning_effort` array is sent as `reasoning_effort` on chat completions and `reasoning.effort` on the Responses wire). Models listing both Copilot endpoints (gpt-5.4, gpt-5-mini) normally speak chat completions but reroute to `/responses` when a request combines function tools with an effort — Copilot rejects that combination on the chat wire:

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
| `copilot` | GitHub Copilot   | live catalog from `api.githubcopilot.com/models` (chat models on both wires, with per-model vision flags and reasoning efforts); login uses the OAuth device flow (enter the shown code at `github.com/login/device`) |

Only logged-in providers appear in the session model picker; the lists above refresh on login/logout. Vision-capable models declare `['text', 'image']` input modalities, and image content is translated to each provider's wire format.

Logged-in cards also show **subscription usage** — per rate-limit window (5-hour session, weekly, and per-model weekly where the plan has one) with the used percentage, a progress bar, and the reset time, plus a Refresh button. Codex usage comes from `chatgpt.com/backend-api/wham/usage` (also reports the plan), Claude usage from `api.anthropic.com/api/oauth/usage` (the plan comes from the stored subscription type, since that payload names no tier), and Grok usage from the Grok Build CLI proxy's `cli-chat-proxy.grok.com/v1/billing` (the source of the CLI's `/usage` panel; reports the shared weekly pool and the subscription tier). Copilot exposes no usage endpoint, so its card shows no usage section.

Claude usage additionally rides a **meter in the composer**, left of the model selector and beside the shell's own context meter: a ring showing the limit that applies to the session's current model — a model with its own weekly limit shows that one, everything else the shared weekly pool — which turns amber at 75% and red at 95%. Hovering names the window and revalidates; clicking opens every reported limit with its reset time. It renders only while a Claude model is selected, so it never reports a limit the next turn will not spend.

The meter is deliberately frugal with that endpoint, which is aggressively rate limited and shared with the settings page above: one cache serves every open session, an idle session issues no request at all, a running one asks every 3 minutes, and a refusal never clears the last good reading. A `Retry-After` on a 429 is honoured when the provider sends one.

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

## Proxy

Every subscription request — token exchanges, model-API streams, usage lookups, model discovery, and the `x_search` / `image_generate` / `video_generate` tools — can be routed through an HTTP(S) proxy. Configure it in **Settings → Subscriptions → Proxy → Configure…**: enable the flag, enter the proxy URL (`http://127.0.0.1:7890`), optional username/password, and an optional comma-separated bypass list of hostnames that stay direct (`127.0.0.1`, `localhost`, `*.example.com`). The password is stored in `~/.dsh/plugins/subscriptions/proxy.json` (mode 0600) and is never returned to the browser. A "Test" button probes one endpoint through the current configuration and shows the HTTP status/latency.

Changes apply immediately to subsequent requests — no restart needed. The OAuth authorization page opens in your browser and follows the browser/system proxy, not this setting. SOCKS proxies are not supported.

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
- `src/providers/` — per-provider OAuth constants/exchange/refresh + `LlmAdapter`s
- `src/translate/` — dsh `Message[]` ⟷ OpenAI Responses / Anthropic Messages wire formats, SSE → `StreamChunk`
- `src/tools/` — `x_search`, `image_generate`, and `video_generate`
- `src/client/` — the Settings → Subscriptions page (browser half, zh/en, theme-token aware)
