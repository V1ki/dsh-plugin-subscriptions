# Image account scheduling

[中文](./image-account-pool.zh.md) · [Documentation](./README.md)

`image_generate` sends both generation and editing requests through `ImageAccountPool`. It reads the same live provider account list as chat, but maintains separate image health and affinity: chat catalogs and chat usage snapshots do not prove image entitlement or quota.

The first request tries accounts in default-first order. Successful requests establish per-session, per-provider affinity shared by generation and editing. Explicit HTTP 429, 401/403, or 402/404 rejection — as well as `ACCOUNT_SUSPENDED` — can move to another account of the selected provider. A 401 refreshes that account once before switching. Provider reset disclosures determine cooldowns when available; otherwise existing pool cooldown constants apply (`ACCOUNT_SUSPENDED` and auth/credential errors use the 24-hour `AUTH_COOLDOWN_MS`, rate limits use the 5-minute `DEFAULT_QUOTA_COOLDOWN_MS`, and 402/404 use the 60-second `TRANSIENT_COOLDOWN_MS`). Login/logout clears image health and affinity. Removed accounts cannot remain candidates.

Parameter errors, transport failures, timeouts, 5xx, and response decoding/storage failures do not automatically resend an image request. An upstream request may already have produced an image in those cases. Exhaustion never changes providers. The existing fallback to another provider when the preferred provider has no login remains unchanged.

`pool.enabled: false` or `pool.autoAccounts: false` disables automatic image account scheduling (`autoFamilies` is accepted as the legacy alias). Chat `strategy`, `families`, and `tiers` do not control image requests.
