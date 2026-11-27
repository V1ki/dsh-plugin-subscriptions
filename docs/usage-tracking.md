# Usage Tracking, Quota Cycles, and Cache Semantics

English | [中文](./usage-tracking.zh.md) · [Docs](./README.md) · [README](../README.md)

This document describes the architecture behind the **Usage Dashboard** (`src/usage/*`), how quota windows and multi-process persistence work, and how the status-bar usage badge and Settings page share live quota snapshots.

## Scope and Privacy Boundary

- **Tracked providers**: `codex`, `claude`, `grok`, and `antigravity` (`USAGE_TRACKED_PROVIDERS` in `src/usage/constants.ts`).
- **Excluded provider**: **Copilot** exposes no subscription usage/quota window endpoint and is excluded from the Usage Dashboard.
- **Privacy boundary**: the plugin stores only aggregate token counts per model and UTC day, observed quota percentages (`quotaUsedPercent`, `quotaPeakPercent`), and window boundary metadata under `~/.dsh/plugins/subscriptions/usage/`. It **never** writes prompts, responses, credentials, or per-request logs there, and opening the dashboard makes no extra upstream quota requests and estimates no dollar cost.

## On-Disk Storage Layout

All usage files live under `~/.dsh/plugins/subscriptions/usage/` (mode `0600` on written files):

```text
~/.dsh/plugins/subscriptions/usage/
├── meta.json                  # Tracking start timestamp & per-provider clear cut-offs
├── meta.lock                  # Transient lock for meta.json updates
└── <provider>/                # codex | claude | grok | antigravity
    ├── open.json              # Currently open window entries across accounts
    ├── closed-YYYY.jsonl      # Append-only closed/ended-early window entries by UTC year
    ├── pre-tracking.json      # One-time per-provider UTC daily totals (v2) of DSH session history before trackingStartedAt
    └── <provider>.lock        # Transient per-provider save/clear lock
```

Damaged files or malformed JSONL lines are skipped and surfaced in `errors[]` rather than breaking the dashboard; file-read diagnostics report only error codes (never raw absolute host paths).

## Window Lifecycle and Deduplication

`WindowTracker` (`src/usage/window-tracker.ts`) is a pure, synchronous state machine fed by three hooks: quota snapshots, completed requests, and confirmed Codex reset-card redemptions.

### Window Kinds and Anchoring

- **Kinds**: `5h` (from `session`), `weekly`, `monthly` (`28d–31d` classified by observed length), `unclassified` (hidden until classified), and `pending` (account-level Window 0 before the account's first quota snapshot arrives).
- **Start-time provenance (`StartSource`)**:
  1. `disclosed`: provider reports the period start directly (`grok` via `currentPeriod.start`).
  2. `length`: provider reports exact window duration (`codex` via `limit_window_seconds`).
  3. `nominal`: fixed nominal length (`5h` or `7d`; used by `claude` and fallback cases; monthly windows have no fixed nominal length).
  4. `previous-reset`: chained directly from the prior window's `resetsAt`.
  5. `redemption`: exact timestamp of a confirmed in-plugin Codex reset-card redemption (splits `5h` and `weekly` windows).
  6. `first-usage` / `observed`: Window 0 or fallback start when no rule yields a start time (for example, after an externally triggered early reset).
- **Early-reset detection vs jitter**: an observed reset within `60s` (`RESET_MATCH_TOLERANCE_MS`) of an open window's `resetsAt` is treated as the same window (absorbing fetch-latency jitter on relative `reset_after_seconds` fields). A shift larger than `60s` marks the prior window `ended-early` (`endReason: 'detected'`) and opens a new window.

### Token Buckets and Deduplication

- Each model sum tracks five disjoint buckets (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`). **Reasoning tokens are a subset of `outputTokens`** and are never double-counted in `totalTokens` (`input + output + cacheRead + cacheWrite`).
- For **Claude** only, `cacheWriteTokens` also stores `cacheWrite5mTokens` and `cacheWrite1hTokens` subsets.
- **Cross-window deduplication (`src/usage/usage-dashboard.ts`)**: a single request can be counted simultaneously in an account's `5h` window, its `weekly` window, and a model-scoped window. To prevent double-counting in daily trends, heatmaps, and KPI totals, the aggregator selects one canonical series per `(provider, account, day, model)` — choosing the highest token total and breaking ties by `weekly > 5h > monthly > pending` (unscoped preferred) — while keeping disjoint model-family scopes (such as Antigravity's Gemini vs Claude/GPT pools) separate.

## Multi-Process Concurrency and Durability

`WindowStore` (`src/usage/window-store.ts`) coordinates concurrent DSH processes (for example, web + headless sessions sharing one `$DSH_HOME`):

- **Zero I/O on the request path**: request-end and snapshot hooks update in-memory state synchronously and schedule a write-behind save (`5s` delay from the first unsaved change, `USAGE_SAVE_DELAY_MS`). Window closes flush immediately; a `60s` advance timer (`USAGE_ADVANCE_INTERVAL_MS`) ensures idle windows close promptly after reset.
- **Delta read-merge-write under lock**: saves acquire `<provider>.lock` (stale takeover after `10s`, `USAGE_LOCK_STALE_MS`; shutdown waits at most `2` lock intervals), read the latest on-disk files, merge only this process's **unsaved deltas**, and replace files atomically via `.tmp-*` + `rename`. Two concurrent processes therefore never overwrite each other's committed counts.
- **Crash recovery ("closed wins on load")**: when a window closes, it is appended to `closed-YYYY.jsonl` **before** `open.json` is rewritten. If a crash occurs between the two writes, the same window ID appears in both files and the closed copy wins on load.
- **Clearing history (`clearProvider`)**: writes a monotonic `clearedAt` cut-off marker into `meta.json` before purging provider files. Even if another process holds unflushed in-memory entries or a purge partially fails, entries with `countedFrom < clearedAt` are immediately hidden and the purge retries cleanly.
- **One-time pre-tracking history fold (`src/usage/pre-tracking.ts`)**: when a host `sessionQuery` service is available, a background scan folds DSH session history prior to `trackingStartedAt` once into `<provider>/pre-tracking.json` (`v2`) as per-provider UTC daily buckets (`days`, deriving per-model `models` on read so they cannot disagree; disjoint buckets only, deduplicated per `(turn, step)` slot, with no account/session identity or Claude `5m`/`1h` cache-write split). Those daily buckets merge into the dashboard's **All accounts** view (KPIs, 26-week heatmap, daily trend, model/provider distribution, and provider pills), while per-account views and quota cycles stay ledger-only. Legacy `v1` files (per-model totals without `days`) stay readable and automatically upgrade to `v2` via a background re-scan; events with missing or unusable timestamps are skipped, and stored pre-tracking days for cleared providers are ignored. Once `v2` is stored (or cleared), reading usage status never re-scans DSH sessions.

## Live Quota Badge and Settings Cache Behavior

Live quota snapshots served to **Settings → Subscriptions** and the composer **subscription usage badge** follow two cache layers:

1. **Server-side cache (`PoolUsageTracker`, `src/providers/pool-usage.ts`)**:
   - Successful snapshots stay fresh for `5 minutes` (`USAGE_TTL_MS`).
   - Failed lookups enter a negative-cache cooldown (honoring the endpoint's `retry-after`, else `5 minutes`) and preserve the last successful snapshot (`lastSnapshot`, marked `stale: true`, `refreshFailed: true`, with `retryAt`) so the UI degrades gracefully instead of flickering blank or causing a 429 retry storm.
   - Clicking an account's **Refresh** button in Settings sends `force: true` to bypass a fresh cached snapshot, but **never** bypasses an active failure cooldown. Opening the usage badge reads normally (non-forced).
   - `displaySnapshotFor` attaches `fetchedAt`, `staleAt`, `stale`, `refreshFailed`, and `retryAt` on a copy for UI display without altering routing scores.
2. **Client-side connection-local cache (`src/client/usage-cache.ts`)**:
   - Open Settings pages and the status-bar usage badge share successful `usage` responses in a connection-scoped, memory-only `WeakMap` (nothing persisted to disk/localStorage) and reread that memory on window focus without issuing extra upstream requests.
   - When `status` reports that an account has logged out, `retainUsageAccounts` prunes its entry from the client cache immediately.
   - If an older backend omits `fetchedAt`, the UI records a local `receivedAt` receipt timestamp and labels it distinctly — receipt time never masquerades as an upstream quota refresh time.
