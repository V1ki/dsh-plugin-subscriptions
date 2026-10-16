/**
 * Minimal SSE byte-stream parser (~30 lines of framing): reassembles chunks,
 * splits CRLF/LF lines, joins multi-`data:` payloads, skips comments and
 * non-data fields, and dispatches an event only on its blank-line terminator.
 * An unterminated tail at EOF is truncation and is dropped, matching the
 * spec-strict framing the harness's own adapters use.
 */
/** One parsed SSE event. */
export interface SseEvent {
    /** Joined `data:` lines of the event. */
    data: string;
    /** The `event:` field, when present. */
    event?: string;
}
/**
 * Decode an SSE byte stream into events.
 * @param stream - raw response bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onActivity - called on every received chunk and comment line; drives the idle watchdog.
 * @returns events in arrival order.
 */
export declare function parseSse(stream: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<SseEvent>;
