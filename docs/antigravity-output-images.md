# Antigravity output images

[中文](./antigravity-output-images.zh.md) · [Documentation](./README.md)

Antigravity `inlineData` responses become durable DSH image blocks in both
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
- Omit Gemini inline images marked `thought: true` (intermediate sketches) from
  visible history and request replay. Only final image bytes are saved and
  replayed with their own signatures; a sketch without final output yields
  `EMPTY_RESPONSE`. See [Google’s image-generation thought signature rules](https://ai.google.dev/gemini-api/docs/generate-content/image-generation?hl=en).
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
  admission without introducing a transport-level frame-size cap. A failure
  after earlier frames may leave already-saved, unreferenced objects; no
  successful finish is emitted for that attempt. Storage retention remains
  host-owned.

## Host compatibility check

An opt-in check exercises the published host's real local attachment backend and
image gallery in an isolated temporary directory without modifying project
dependencies or an existing DSH home. Compile the tests first (`pnpm exec tsc -p tsconfig.test.json`),
then install the host packages into a temporary prefix and run the script:

```sh
HOST_CHECK_DIR=$(mktemp -d)
npm install --prefix "$HOST_CHECK_DIR" --save-exact --no-audit --no-fund \
  @deepseek-ai/dsh-attachment-local@0.2.3-alpha.2 \
  @deepseek-ai/dsh-client-ui-attachment@0.2.3-alpha.2 \
  @deepseek-ai/dsh-client-ui-chat@0.2.3-alpha.2 \
  @deepseek-ai/dsh-llm@0.2.3-alpha.2
node scripts/verify-antigravity-images-host.mjs "$HOST_CHECK_DIR"
```
