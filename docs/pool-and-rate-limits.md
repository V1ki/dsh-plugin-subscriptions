# Model Pools, Credit Fallback, and Rate-Limit Handling

English | [中文](./pool-and-rate-limits.zh.md) · [Docs](./README.md) · [README](../README.md)

This document describes how `PoolAdapter` selects accounts, handles quota exhaustion and Codex purchased credits, classifies failures into cooldowns, parses provider 429 reset signals, and guards manual Codex reset-card redemptions.

For image tool scheduling (which is independent of chat model pools), see [Image account scheduling](./image-account-pool.md). For per-account pool allowlists and independent account model entries, see [Account and model management](./account-management.md).

## Account Pools, Families, and Tiers

When a provider has two or more logged-in accounts and `pool.enabled` + `pool.autoAccounts` are enabled, the model picker presents the **union** of every eligible account's catalog (deduplicated by model ID):

- **Shared models** (listed by ≥2 accounts) fail over across those accounts with per-session stickiness.
- **Account-only models** (listed by 1 account) route directly to that account while still appearing in the picker even if it is not the default account.
- **Explicit `pool.families`** replace the automatic member list for a specific catalog model (same provider only; cross-provider entries are ignored).
- **Optional `pool.tiers`** add extra picker entries with heterogeneous (cross-model or cross-provider) member lists under the first member's provider.
- **Conservative capability intersection**: `resolveModel` intersects members' `contextWindow` (minimum), `defaultMaxTokens` (minimum), `reasoning.efforts` (common subset), and `inputModalities` (common subset) so requests remain valid after failover.

### Account Key Resolution (`pool.families` / `pool.tiers`)

- Omitting `account` resolves to the provider's current default account.
- For Claude, Grok, Copilot, and Antigravity, `account` is the stable account key (typically email or login name).
- For **Codex**, canonical account keys include both workspace and user (`["<workspace-id>","user","<user-id>"]`). In config, you may pin the canonical key, the login email, or a bare workspace ID (when only one user of that workspace is logged in). Ambiguous references resolve to nothing rather than guessing an account.

## Selection Strategies and Quota Tiers

Every strategy first filters out members whose adapter is unavailable, that are cooling down in `PoolHealthRegistry`, or that are **exhausted** (`usedPercent >= 100` on an applicable window with no spendable Codex credits).

When **all** currently usable members are exhausted and none has spendable credits, selection stops immediately with a `QUOTA` error (preventing silent spend).

### Credit-Funded Tier (`creditFunded`)

For Codex accounts (`src/providers/pool-usage.ts`, `codexCreditsFunded`):

- An account with an applicable window at `>= 100%` stays eligible **only** when `credits` indicates spendable balance: `overageLimitReached !== true` AND (`unlimited === true`, or finite `Number(balance) > 0`, or `balance === undefined && hasCredits === true`).
- Eligible members are partitioned into two priority tiers across **all** strategies:
  1. **Included quota** (`creditFunded !== true`): every account with remaining included subscription quota (including `95%–99%` near-full accounts).
  2. **Credit-funded fallback** (`creditFunded === true`): accounts at `>= 100%` with spendable Codex credits. These always rank **after** every account that still has included quota.

### Strategy Comparison

| Strategy | Ranking Formula | Near-Full (`95%–<100%`) | Session Stickiness |
| --- | --- | --- | --- |
| `priority` | Configured/default pool order within `included`, then `creditFunded`. | Treated like other `included` members. | Keeps the sticky member unless it is cooling, exhausted, or `stickySpendsCredits` is true (`sticky` is `creditFunded` while any `included` member exists). |
| `quota_aware` *(default)* | Required burn rate: `max(remaining / timeUntilReset)` across applicable windows (fraction per ms). Missing `resetsAt` falls back to `5h` / `7d` / `30d` horizons; unmeasured providers (e.g., Copilot) score `0`. | Deferred into `nearFull` behind `< 95%` (`scored`) members, ranked by urgency, and always ahead of `creditFunded`. | Within `scored`, sticky holds unless `bestUrgency > stickyUrgency * switchMargin` (default `2`). When `scored` is empty, sticky holds inside `quotaFull` (`[...nearFull, ...creditFunded]`) **only** when `!stickySpendsCredits` — so a sticky `creditFunded` account yields to a `95%–99%` included-quota account, while staying sticky once all included quota is exhausted. |
| `quota_normalized` | Dimensionless relative pacing: `remaining / clamp(timeLeft / durationMs, 0.001, 1)`. When `durationMs` or `resetsAt` is absent, falls back to `remaining` alone without guessing a window length. | Same `95%` near-full tier, `100%` exclusion, and `creditFunded` last-resort tier as `quota_aware`. | Same hysteresis and `!stickySpendsCredits` rules as `quota_aware`. |

Notes on stickiness and telemetry:

- Stickiness is tracked in memory per `sessionId|poolId` (LRU-bounded at `1000` entries) and updates only after a member emits its first non-usage content chunk.
- `PoolUsageTracker` caches snapshots for `5 minutes` (stale-while-revalidate for healthy members). Exhausted and `creditFunded` snapshots block on refresh once expired so a reset or depleted balance takes effect on the next call. Fetch failures enter a negative-cache cooldown while preserving prior known exhaustion or `creditFunded` status until a live refresh succeeds.

## Failure Classification and Cooldowns

Failover only occurs **before** the first content chunk is yielded (leading `usage` chunks are buffered). Cooldowns live in memory (`PoolHealthRegistry`, `src/providers/pool-health.ts`) and reset on restart or auth changes (login/logout clears that account's records).

| Failure Code | Action | Cooldown Duration | Scope |
| --- | --- | --- | --- |
| `QUOTA`, `RATE_LIMIT` | Switch & expire usage cache | Provider `retry-after` / reset hint, else `5m` (`DEFAULT_QUOTA_COOLDOWN_MS`) | **Member** for `claude` and `antigravity` (model-scoped quotas); **Account** for `codex`, `grok`, `copilot`. |
| `ACCOUNT_SUSPENDED` | Switch | `24h` (`AUTH_COOLDOWN_MS`) | Account |
| `AUTH`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL` | Switch | `24h` (`AUTH_COOLDOWN_MS`, cleared immediately on re-login) | Account |
| `SERVER` | Switch | `60s` (`TRANSIENT_COOLDOWN_MS`); Codex honors SSE overload `retry-after` when disclosed | Member |
| `TIMEOUT`, `HTTP_402`, `HTTP_404` | Switch | `60s` (`TRANSIENT_COOLDOWN_MS`) | Member |
| `EMPTY_RESPONSE`, `TRANSPORT` | Switch | **None** (no cooldown recorded; other sessions can still use the member) | — |
| `CONTEXT_WINDOW_EXCEEDED`, `ABORTED`, `HTTP_400`, image output errors, other errors | Rethrow immediately | None | — |

## Per-Provider 429 Reset Signals and Waiting

Only signals that identify the specific window that rejected a request are parsed on HTTP `429` (`src/providers/rate-limit.ts` and `src/providers/common.ts`):

| Provider | Honored 429 Reset Signals (in priority order) | Deliberately Ignored (Diagnostic Only) |
| --- | --- | --- |
| **Codex** | JSON body fields `resets_in_seconds`, `reset_after_seconds`, `resets_at`, `reset_at` → fallback `retry-after` header | `x-codex-{primary,secondary}-reset-after-seconds` (rollover snapshots sent on every response) |
| **Claude** | `anthropic-ratelimit-unified-reset`, `anthropic-ratelimit-unified-fallback-reset` headers → JSON body `resets_at`, `resetsAt`, `reset_at`, `retry_after` → fallback `retry-after` header | `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset` (per-bucket rollover snapshots) |
| **Grok** | JSON body fields `retry_after`, `retry_after_seconds`, `resets_at`, `reset_at` → fallback `retry-after` header | `x-ratelimit-reset-*` (per-bucket rollover snapshots) |
| **Antigravity** | JSON body `quotaResetDelay` / `quotaResetTimeStamp` (`googleQuotaReset`) → fallback `retry-after` header | — |
| **Copilot** | RFC 7231 `retry-after` header | Unrecognized GitHub headers are logged via `onWarn` |

When a 429 discloses no recognized reset instant, a single diagnostic line naming rate-limit headers and the first 200 characters of the body is emitted to `onWarn`.

### Retry Policy and `rateLimit.maxWaitMs`

- Every subscription route advertises the same retry policy to `@deepseek-ai/dsh-llm-retry`: `10` retries after the first attempt, exponential backoff starting at `1s` with `20%` jitter, and a `60s` local backoff cap (`DEFAULT_RETRY`).
- Provider-disclosed resets add `2s` clock-skew grace (`RESET_GRACE_MS`, minimum `1s`) and are deliberately **uncapped** when attached as `providerRetryAfterMs`. If the wait exceeds `rateLimit.maxWaitMs` (default `6h`), `@deepseek-ai/dsh-llm-retry` fails the turn immediately with the reset time rather than burning retries against a closed window.
- **Pool interaction**: a 429 on one account cools that member/account and fails over immediately with zero wait. Only when **every** pool member is cooling does the pool surface `RATE_LIMIT` with the earliest recovery time across its members.
- **Backoff ceiling trade-off**: when `rateLimit.wait: true`, the route's retry `maxDelayMs` is widened to `max(60s, rateLimit.maxWaitMs)` so long window waits are accepted. Because that ceiling is shared with local exponential backoff, transient failures (`TRANSPORT`, `SERVER`, `TIMEOUT`) without a disclosed reset can back off up to `512s` on the 10th retry instead of capping at `60s`. Setting `rateLimit.wait: false` restores the `60s` ceiling (~5 minutes total across 10 retries).

## Codex Reset-Card Redemption Guardrails

Manual banked-reset redemption (`src/providers/reset-redemption.ts`, triggered from **Settings → Subscriptions**) enforces strict safety checks so a reset card is never spent accidentally or double-submitted:

1. **Manual two-step confirmation**: `prepareReset` fetches fresh usage, picks the soonest-expiring available reset credit, and issues a **single-use 60-second confirmation ticket**.
2. **Eligibility floor**: redemption is blocked unless the fresh account-wide weekly window reports `>= 80%` used with a future `resetsAt` and no `resetCreditsError`.
3. **No blind retries on ambiguity**: before calling Codex's `/consume` endpoint, the account is placed in an in-memory `uncertain` lock. If the consume call fails or times out with an ambiguous outcome, further reset attempts for that account remain blocked until verified in Codex.
4. **Usage tracker split**: only after `/consume` returns confirmed `code: "reset"` does the redemption notify the usage tracker (`onRedeemed`) to split the account's `5h` and `weekly` windows at that exact timestamp.
