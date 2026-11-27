# Documentation

[中文](./README.zh.md) · [Main README](../README.md)

Reference guides and architecture notes for `dsh-plugin-subscriptions` (see [README](../README.md) for quick start and overview).

- [Account and model management](./account-management.md) — display names, account aliases, automatic pool participation, model allowlists, independent account entries, Claude prompt cache lifetime, and Antigravity opt-in.
- [Configuration and storage](./configuration-and-storage.md) — full YAML config schema, environment variables, and `~/.dsh/plugins/subscriptions/` local file layout.
- [Providers](./providers.md) — per-provider auth flows, endpoints, wire quirks, and advanced options for Codex, Claude, Grok, GitHub Copilot, and Google Antigravity.
- [Pool and rate limits](./pool-and-rate-limits.md) — account pool scheduling strategies, failure classification, cooldowns, 429 retry policies, and Codex reset-card guardrails.
- [Usage tracking](./usage-tracking.md) — Usage Dashboard storage, quota window lifecycle, multi-process durability, and status-bar badge caching.
- [Image account scheduling](./image-account-pool.md) — `ImageAccountPool` failover, affinity, cooldowns, and retry boundaries for `image_generate`.
- [Antigravity output images](./antigravity-output-images.md) — durable attachment contract, admission/failure boundaries, and isolated host compatibility check for Antigravity `inlineData` image responses.
- [Development](./development.md) — DSH host compatibility policy, build/test commands, offline Playwright UI regression scripts, release workflow, and repository layout.
- [`images/`](./images/) — UI screenshots referenced by the READMEs and [`screenshots.json`](../screenshots.json).
