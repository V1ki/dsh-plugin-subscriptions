# Development

[中文](./development.zh.md) · [Documentation](./README.md)

Build, test, compatibility policy, UI regression verification, release automation, and repository layout for `dsh-plugin-subscriptions`.

## DSH host compatibility and peer-range policy

- **Current dev/test baseline**: `package.json` pins all `@deepseek-ai/dsh-*` devDependencies to `0.2.3-alpha.2`, `@deepseek-ai/cordis` to `4.2.0-alpha.1`, and `@deepseek-ai/schemastery` to `3.20.0-alpha.1` (with Node 24 and `pnpm@10.26.2`).
- **Minimum-only peer policy**: Every `@deepseek-ai/dsh-*` peer dependency (`@deepseek-ai/dsh-attachment`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-web`) uses the exact shared range:
  ```
  >=0.2.0-rc.2 || >=0.2.1-0 || >=0.2.2-0 || >=0.2.3-0
  ```
  `@deepseek-ai/cordis` (`^4.0.1 || 4.0.5-alpha.1 || 4.0.5-alpha.2 || ^4.2.0-0`) and `@deepseek-ai/schemastery` (`^3.18.1 || 3.18.5-alpha.1 || 3.18.5-alpha.2 || ^3.20.0-0`) carry matching prerelease anchors for the `0.2.3` line. There is intentionally no `engines.dsh` override; compatibility invariants are enforced by `test/dsh-compatibility.spec.ts`.
  - **Why prerelease anchors exist**: DSH app-boot evaluates ranges with `includePrerelease: true`, whereas npm/pnpm default to `includePrerelease: false`. Anchoring `0.2.1-0`, `0.2.2-0`, and `0.2.3-0` admits every prerelease on those lines under both evaluators without per-RC entries, while excluding the entire retired `0.1.x` line and versions below `0.2.0-rc.2`. When a new host prerelease line (e.g. `0.3.0-alpha.1`) is officially supported, add its `-0` anchor to the peer range and update `test/dsh-compatibility.spec.ts`.
- **Host bundle metadata**: `package.json` declares `dsh.bundle.patch` pointing to `cordis.patch.yml` (Node half self-activation) and `dsh.client` (`platform: "web"`, injecting `@deepseek-ai/dsh-client-ui-renderer`, `@deepseek-ai/dsh-client-ui-settings`, and `@deepseek-ai/dsh-client-locale`).

## Build and unit tests

```sh
pnpm install        # install dependencies (CI uses: pnpm install --frozen-lockfile)
pnpm build          # tsc && tsdown (typecheck src/ + bundle lib/index.js & lib/client.js)
pnpm test           # tsc -p tsconfig.test.json && node --test "lib-test/test/**/*.spec.js"
```

Additional lifecycle scripts in `package.json`:

- `pnpm prepare`: runs `tsdown -c tsdown.prepare.config.ts`
- `pnpm prepublishOnly`: runs `pnpm build && pnpm test`

Type checking runs inside both `pnpm build` (`tsc`) and `pnpm test` (`tsc -p tsconfig.test.json`); there is no separate `typecheck` script.

## Offline Playwright UI regression checks

Eight standalone browser scripts under `test/*-browser.mjs` bundle React fixtures via the installed `rolldown` package and drive headless Chromium completely offline (no live DSH server, no real accounts or credentials).

Point `PLAYWRIGHT_PATH` to a local Playwright package directory (optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a custom Chromium binary):

```sh
# 1. Manage dialog (account defaults, pool allowlist, subagent speed, bilingual & narrow layout)
PLAYWRIGHT_PATH=/path/to/playwright node test/account-manager-browser.mjs

# 2. Real SubscriptionsAuthController + PoolUsageTracker + RPC routes (requires compiled tests)
pnpm exec tsc -p tsconfig.test.json
PLAYWRIGHT_PATH=/path/to/playwright node test/freshness-browser.mjs

# 3. Provider model editor (visibility, context windows, tools, subagent speed, display names, efforts)
PLAYWRIGHT_PATH=/path/to/playwright node test/model-editor-browser.mjs

# 4. Provider tab bar, narrow viewport scrolling, login transitions, and Codex credit balance display
PLAYWRIGHT_PATH=/path/to/playwright node test/provider-tabs-browser.mjs

# 5. Quota display modes (used/remaining), stale/failure recovery, cross-tab sync, Chinese & narrow layout
PLAYWRIGHT_PATH=/path/to/playwright node test/quota-display-browser.mjs

# 6. Settings help tooltips across hover, keyboard focus/Escape, click-outside, and touch
PLAYWRIGHT_PATH=/path/to/playwright node test/settings-help-browser.mjs

# 7. Status-bar usage badge visibility modes, storage error resilience, bilingual setting & narrow layout
PLAYWRIGHT_PATH=/path/to/playwright node test/subscription-usage-browser.mjs

# 8. Provider-defined quota groups (e.g. Antigravity), remaining indicators & immediate visibility updates
PLAYWRIGHT_PATH=/path/to/playwright node test/usage-window-filter-browser.mjs
```

## Isolated host compatibility checks and manual probes

- **Antigravity output images host check (`scripts/verify-antigravity-images-host.mjs`)**: Exercises real published `@deepseek-ai/dsh-attachment-local`, `@deepseek-ai/dsh-client-ui-attachment`, `@deepseek-ai/dsh-client-ui-chat`, and `@deepseek-ai/dsh-llm` packages (`0.2.3-alpha.2`) in an isolated temporary npm prefix and DSH home without altering project dependencies. See [Antigravity output images](./antigravity-output-images.md) for the exact commands.
- **Copilot replay probe (`scripts/manual/real-copilot-replay-probe.mjs`)**: Manual diagnostic script for verifying Copilot Responses encrypted reasoning replay against live endpoints.

## Release workflow

Automated publishing lives in `.github/workflows/release.yml` and triggers on pushing a `v*` git tag:

1. Bump `"version"` in `package.json`, commit on `main`, and push a matching tag `vX.Y.Z`:
   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
2. The `Release` workflow runs on `ubuntu-latest` (Node 24, `pnpm` from `packageManager`, latest `npm` ≥ 11.5.1):
   - Verifies the tag matches `v${package.json.version}` and is not already published on npm.
   - Assigns dist-tag `next` (and `--prerelease` on GitHub) when the version contains `-`, otherwise `latest`.
   - Runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, and `npm pack --dry-run`.
   - Publishes via **npm Trusted Publishing (OIDC)** with provenance (`npm publish --registry=https://registry.npmjs.org --provenance --access public --tag "$DIST_TAG"`, no long-lived npm token).
   - Creates the GitHub Release via `gh release create "$TAG" --verify-tag --generate-notes`.

## Repository layout

```text
.
├── cordis.patch.yml                 # DSH bundle self-activation patch
├── package.json                     # Package metadata, peer ranges, build/test scripts
├── screenshots.json                 # Manifest of README screenshots in docs/images/
├── .github/workflows/release.yml    # Tagged OIDC npm publish & GitHub release workflow
├── docs/                            # Documentation index, technical references, and screenshots
├── scripts/
│   ├── verify-antigravity-images-host.mjs   # Isolated host attachment/gallery check
│   └── manual/real-copilot-replay-probe.mjs # Manual Copilot Responses replay probe
├── src/
│   ├── index.ts                     # Cordis plugin entry, Config schema, RPC & tool wiring
│   ├── http.ts                      # Outbound proxy routing (proxy.json) & Happy Eyeballs timeout floor
│   ├── provider-settings.ts         # Persistent per-provider UI preferences (provider-settings.json)
│   ├── model-defaults.ts            # Per-model default reasoning efforts (model-defaults.json)
│   ├── model-speeds.ts              # Codex composer speed persistence (model-speeds.json)
│   ├── codex-budget-defaults.ts     # Codex fallback context window & local output reserve constants
│   ├── antigravity-model-id.ts      # Antigravity family ID & quota scope helpers
│   ├── compat.ts / json-text.ts     # Cross-host type/BOM helpers
│   ├── auth/                        # auth.json store, OAuth PKCE & device flows, Claude Keychain sync, RPC
│   ├── providers/                   # Per-provider adapters, token managers, model pools, health, usage, reset cards
│   ├── translate/                   # Anthropic, Responses, Chat Completions, Antigravity & image translators
│   ├── tools/                       # image_generate, video_generate, x_search, and alias registration
│   ├── usage/                       # Local usage window tracking, pre-tracking fold, dashboard aggregation & RPC
│   └── client/                      # Web Settings UI, quota badge, model/account editors, Usage Dashboard
│                                    # (UsageDashboard.tsx, UsageCharts.tsx, UsageHeatmap.tsx,
│                                    #  ActiveWindowsPanel.tsx, usage-dashboard-state.ts, usage-dashboard-styles.ts)
└── test/                            # Node unit tests (*.spec.ts) & offline Playwright browser regressions (*-browser.mjs)
```
