# Claude deferred tool loading: verification

`claudeDeferTools` sends the listed tools with `defer_loading: true` and adds the server-side tool search tool
(`tool_search_tool_regex_20251119`) to the Claude route's `tools`. With the option empty (the default) the request body is
byte-identical to 0.9.13; `test/claude-deferred-tools.spec.ts` pins that.

## Live check against the subscription endpoint, 2026-11-18

One Claude Pro/Max account, `claude-sonnet-5-5`. Headers were the ones this plugin sends (`anthropic-beta` =
`CLAUDE_BETA_FALLBACK`, `user-agent: claude-cli/2.1.325 (external, cli)`, `x-app: cli`), and `system` started with the Claude
Code identity block. No beta value beyond the existing ones was needed. No token, e-mail or account id is recorded here.

| # | Request | Result |
| --- | --- | --- |
| A | one plain tool (control) | HTTP 200, `stop_reason: tool_use`, 443 input tokens |
| B | only tools with `defer_loading: true` | HTTP 400 `At least one tool must have defer_loading=false. All tools cannot be deferred.` |
| C | `tool_search_tool_regex_20251119` + one deferred tool | HTTP 200; blocks `text`, `server_tool_use`, `tool_search_tool_result` (with a `tool_reference`), `tool_use` (`caller: direct`) |
| D | second turn: history with the search blocks and a `tool_result` | HTTP 200, `end_turn`, correct answer |
| I | second turn with only `text` and `tool_use` in history (search blocks dropped) | HTTP 200 |
| E1 | 30 tools of about 600 tokens, none deferred | 18,658 input tokens |
| E2 | the same 30 tools, all deferred, plus the search tool | 713 input tokens (−96.2 %) |
| F | `tool_search_tool_bm25_20251119` instead | HTTP 200, same structure as C |
| H | `defer_loading` and `cache_control` on the same tool | HTTP 400 `Tools with defer_loading cannot use prompt caching.` |

## End-to-end with this change, same day

`ClaudeAdapter` built from this branch (`deferToolPatterns: () => ['mcp__*']`) sent one real request with `bash` plus 30 tools
named `mcp__servico__acao_NN` (about 600 tokens each), `system` = a one-line instruction, and the same account and model as above.
The usage the adapter reported, from the stream:

| Run | `inputTokens` | `cacheReadTokens` | `cacheWriteTokens` | finish |
| --- | ---: | ---: | ---: | --- |
| `deferToolPatterns` empty | 4 | 12,994 | 0 | `stop` |
| `deferToolPatterns: ['mcp__*']` | 4 | 779 | 0 | `stop` |

Both runs read their prefix from the prompt cache (the second is a different, much smaller prefix, so it is a different cache
entry that happened to be warm from the earlier probes). This shows the request is accepted and that a prefix with deferred tools
is served from cache; it does not measure a hit rate across turns, which depends on how a session grows. The earlier standalone
cache probe (two identical requests) was rate-limited with 429 on the day and is not part of the evidence.

Two facts the implementation relies on, both from the table: the search tool counts as the loaded tool, so deferring every
other tool is accepted (B fails only without it); and a second turn is accepted with or without the search blocks in the
replayed history (D and I), so the stream translator can keep ignoring `server_tool_use` and `tool_search_tool_result` as it
does today. `test/fixtures/claude-tool-search-stream.sse` is a real stream from check C with ids replaced; the test feeds it to
`AnthropicStreamTranslator` and expects exactly one `tool-call` block.

## Usage reporting when the search runs

With a search inside the turn, `message_start` reports only the first iteration's input (728 tokens in the fixture) while
`message_delta` carries the cumulative total (1,638, with an `iterations` array of 728 + 910). The translator now takes the input and
cache figures from `message_delta` when it sends them. On an ordinary reply the two events already carry identical figures (checked live,
two requests: 422 / 0 / 0 in both), so non-search turns report exactly what they did before. `test/claude-deferred-tools.spec.ts` covers both.

## What this change does not do

DSH core does not mark MCP tools with `deferLoading` today (`dsh-mcp-client` registers them without it), and this route does not
declare `toolUpdate`, so a marker set by core would be removed before the request reaches this plugin (`projectToolUpdates` in `@deepseek-ai/dsh-llm`). `claudeDeferTools` is
the plugin-level way to defer without waiting for either. Reading tool-search results back as a typed harness block, or
choosing the BM25 variant, are separate follow-ups.
