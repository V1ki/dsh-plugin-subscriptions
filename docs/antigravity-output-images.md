# Antigravity output images (#186)

Antigravity `inlineData` responses now become durable DSH image blocks in both
`stream()` (SSE) and `generate()` (JSON). A successfully stored image counts as
content, including when it is the entire answer. No account-pool policy changes
are involved.

## Contract and implementation

The host output shape is `{ type: 'image', attachment: ImageAttachmentRef }`.
`{ type: 'image', mediaType, dataBase64 }` is this plugin's resolved **request**
representation, not a valid durable assistant block.

The translator awaits `AttachmentStore.saveImage()` before emitting the image's
`block-start` and `block-end`. It closes preceding text/reasoning blocks first,
so subsequent text cannot merge across an image. Every image occurrence gets a
new index, including identical images repeated in different frames. Per-block
thought signatures survive storage and replay. Assistant image resolution keeps
one output block per input block; user/tool image editing hints are unchanged.

The host's `BlockAssembler` consumes these chunks, and its
`AssistantStreamAccumulator` / `expandAssistantStream` preserve them through
JSON serialization. The assistant message carries attachment references rather
than base64. Request replay reads bytes back through `resolveImages()`, then
`toAntigravityContents()` restores `inlineData` and thought signatures for the
originating route. Host normalization can change encoded bytes; replay uses the
stored, validated image.

The official `dsh-client-ui-chat` assistant renderer groups consecutive image
blocks at their position in the answer and calls
`conversation.chat.message.images`. `dsh-client-ui-attachment` implements this
slot; the conversation's image loader reads session-authorized attachments and
creates a browser URL. Both the host attachment backend and the image UI plugin
must be mounted for the complete interactive path.

Usage is emitted before finish. The latest usage snapshot is retained if the
terminal frame has no usage. Existing STOP, tool-call, MAX_TOKENS and content
filter completion semantics remain. EOF / `[DONE]` without a finish reason is a
truncated stream, and a JSON response missing a finish reason also fails.

## Admission and failure boundaries

- Accept canonical padded base64 and the host-supported raster MIME types:
  PNG, JPEG, WebP and GIF. Reject empty data, data URLs, malformed base64 and
  unsupported MIME types without copying the payload into diagnostics.
- Bound decoded image bytes before allocation using the host's per-image and
  aggregate byte limits; count and aggregate bytes accumulate across frames in
  one response. These are output admission limits, separate from request-side
  image offloading or base64 budgets.
- Delegate MIME-versus-bytes verification, full raster decoding, pixel and
  dimension limits, normalization and durable writes to the attachment store.
- Missing storage, bad images, output limits and local storage failures fail
  explicitly (`UNSUPPORTED`, `INVALID_IMAGE_RESPONSE`, `IMAGE_OUTPUT_LIMIT`,
  `IMAGE_OUTPUT_STORAGE`). These codes do not trigger pool account switching or
  cooldown. Genuine empty responses retain existing pool behavior.
- The existing HTTP/SSE parser still buffers each JSON frame before image
  admission. This change does not introduce a transport-level frame-size cap.
  A failure after earlier frames may leave already-saved, unreferenced objects;
  no successful finish is emitted for that attempt. Storage retention remains
  host-owned.

## Verification

Run the regular checks from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec tsc -p tsconfig.test.json
node --test lib-test/test/antigravity-images.spec.js lib-test/test/antigravity.spec.js lib-test/test/account-replay.spec.js lib-test/test/pool.spec.js
pnpm test
pnpm build
```

The regression suite injects HTTP responses through the actual adapter for
SSE/JSON and mixed/image-only answers. It checks ordered multi-image frames,
usage, signatures, valid completion reasons, malformed/truncated images and
streams, limits, cancellation and missing/failing storage. Real `PoolAdapter`
tests assert account call counts and cooldown state, including genuine empty
response controls. The unit attachment store is a fixture, not a raster decoder.

An opt-in check uses the published host's real local attachment backend and
image gallery without modifying the project's dependencies or an existing DSH
home. Compile the tests first, then install the exact packages into a temporary
prefix:

```sh
HOST_CHECK_DIR=$(mktemp -d)
npm install --prefix "$HOST_CHECK_DIR" --save-exact --no-audit --no-fund \
  @deepseek-ai/dsh-attachment-local@0.2.1-rc.3 \
  @deepseek-ai/dsh-client-ui-attachment@0.2.1-rc.3 \
  @deepseek-ai/dsh-client-ui-chat@0.2.1-rc.3 \
  @deepseek-ai/dsh-llm@0.2.1-rc.3
node scripts/verify-antigravity-images-host.mjs "$HOST_CHECK_DIR"
```

Verified on 2026-11-06:

| Check | Result |
| --- | --- |
| Type check and build | Passed |
| Related adapter/replay/pool tests | 145 passed |
| Full test suite | 726 passed, 0 failed |
| Real host PNG/JPEG/WebP/GIF × SSE/JSON × mixed/image-only | All 16 passed |
| Actual file storage reopened, compact stream decoded, message/request replayed | Passed for all 16 cases |
| Large random PNG, 1,576,452 base64 characters (larger than reported payload) | Accepted |
| Real decoder: MIME mismatch, truncated raster, pixel/dimension caps | Rejected as expected |
| Official assistant image slot and gallery | React SSR emitted an `img` using reopened image bytes |

The SSR check uses a preloaded attachment URL and a small slot registry harness;
unused UI primitives are stubbed. It does **not** execute browser effects,
session RPC authorization, interactive layout, Windows desktop rendering, or a
full live agent loop. No real Antigravity generation or credentials were used.
Those remain manual acceptance checks; reported upstream capability is not
independently verified here. The checked-in normal tests use locked DSH
`0.2.1-rc.2`; the opt-in host check prints its actual `0.2.1-rc.3` package versions.

## Provenance and scope

- [Issue #186](https://github.com/V1ki/dsh-plugin-subscriptions/issues/186) reports
  DSH 0.2.1-rc.3, plugin 0.9.12 and a JPEG response with 927,472 base64 characters.
- [Prior four-case reproduction](https://github.com/V1ki/dsh-plugin-subscriptions/issues/186#issuecomment-6675328724)
  used injected responses, not live generation or UI verification.
- Base rechecked for this fix:
  [`5d89c40edba000a131fe83407ed47be12e464538`](https://github.com/V1ki/dsh-plugin-subscriptions/commit/5d89c40edba000a131fe83407ed47be12e464538).
  Open PRs and remote branches were checked before implementation; no direct
  image-output fix was found. The remote `feat/antigravity-subscription` head was
  already an ancestor of main. #163 changes empty-response handling, not image
  translation. #188 is outside this change.
- Host contract sources inspected from the installed, versioned npm packages:
  `@deepseek-ai/dsh-llm` (`types`, `assembler`, `assistant-stream`),
  `@deepseek-ai/dsh-attachment` (`AttachmentStore`, `ImageAttachmentRef`),
  [`@deepseek-ai/dsh-attachment-local@0.2.1-rc.3`](https://www.npmjs.com/package/@deepseek-ai/dsh-attachment-local/v/0.2.1-rc.3),
  [`@deepseek-ai/dsh-client-ui-chat@0.2.1-rc.3`](https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-chat/v/0.2.1-rc.3),
  and [`@deepseek-ai/dsh-client-ui-attachment@0.2.1-rc.3`](https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-attachment/v/0.2.1-rc.3).

A Gemini inline image marked `thought: true` is an intermediate sketch, not an answer attachment. It is omitted from visible history and request replay. Only final image bytes are saved and replayed with their own signatures; a sketch without final output yields `EMPTY_RESPONSE`. See [Google’s image-generation thought signature rules](https://ai.google.dev/gemini-api/docs/generate-content/image-generation?hl=en).
