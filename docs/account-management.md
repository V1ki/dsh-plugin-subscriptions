# Account and model management

[中文](./account-management.zh.md) · [Documentation](./README.md)

Configure accounts and provider preferences in **Settings → Subscriptions → provider → Manage**. Edits stay in a local draft until saved; canceling discards them without writing to disk.

## Configuration options

- **Subscription display name / Model display name**: Customize the provider display name (used in the status-bar quota badge and subscription headings) and individual model names; leave blank to restore defaults. Display names are presentation-only and never act as routing or binding keys.
- **Alias**: Optional label such as "Personal" or "Work". Independent model entries display the alias while binding internally to the account's stable key; renaming an alias never breaks the binding.
- **Include in the LLM account pool**: Allows the account to participate in automatic pool scheduling for standard chat model entries. Enabled by default.
- **Pool model allowlist**: Restricts which models this account may serve in the pool. "Allow all models, including future models" (absent allowlist) follows all discovered models including future additions; an explicit selection restricts to the chosen list; an empty selection permits none.
- **Independent model entry**: Adds separate single-account entries to the model picker. Disabled by default; when enabled, those entries stay bound directly to that account without pool failover.
- **Prompt cache lifetime (Claude only)**: Overrides the conversation prompt cache TTL to `5 minutes`, `1 hour`, or `Follow config`. Cache reads cost the same under either TTL, while 1-hour cache writes cost 2× base input (versus 1.25× for 5 minutes). Changes apply from the next turn after saving.
- **Google Antigravity disabled by default**: Due to upstream ToS suspension risk and request blocking, Antigravity starts disabled and must be enabled manually in **Settings → Subscriptions → Google Antigravity** after acknowledging the risk notice. Saved accounts remain preserved locally while disabled without issuing requests; even when manually enabled, usage is currently limited to inspecting account quotas rather than chatting with models.

Antigravity pool allowlists select model families; reasoning effort is controlled separately in the model picker. Legacy `-low`, `-medium`, `-high`, and `-xhigh` selections match their family only when that account's current catalog replaces the concrete entry with the family. Still-listed manual concrete models and unknown IDs stay exact; `-tiered` aliases are not guessed. Reads do not rewrite saved settings. The editor shows the corresponding family, and unchecking it removes the legacy selections on save. This compatibility mapping does not preserve an old effort restriction or change the default reasoning effort.

## Work and personal account example

| Account | Alias | Include in automatic pool | Independent model entry |
|---|---|---|---|
| Personal account | Personal | On | Optional |
| Work account | Work | Off | On |

Standard model entries only use accounts enabled for automatic pooling. Selecting an independent model entry labeled "Work" routes exclusively to the work account; if the account is removed, its independent entry is turned off, credentials fail, or quota is exhausted, it will not silently fall back to the personal account.

## Scope and limitations

These controls govern the plugin's **LLM chat model routing** only and are not a session-wide privacy-isolation switch. Tools such as image generation, video generation, and X search retain their own account policies, and subagents explicitly selecting other models are not automatically bound to the same account. Do not rely solely on this setting when strict work/personal data isolation is required.

Provider-level **Edit model list** continues to manage model visibility, context windows, and tool toggles; account settings do not reset those preferences. The default-account star and the automatic-pool toggle are independent settings.
