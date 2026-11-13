/**
 * Tracked pass-through stream. This is the piece that turns "the user clicked
 * a link" into "the user received the whole file": the origin body is piped
 * to the client and the pipe's outcome says deterministically whether the
 * transfer completed (origin fully drained and delivered) or was aborted
 * (client went away, or the origin failed).
 *
 * Two Workers-specific constraints shape this:
 *  - The pipe MUST be `source.pipeTo()` into an identity stream: both ends
 *    are native, so workerd runs the copy in native code with near-zero CPU.
 *    A hand-rolled reader/writer loop crosses the JS boundary per 16KB chunk
 *    — on a 266MB installer that burned ~2s of CPU and hit the Workers CPU
 *    limit mid-download, killing the transfer. The cost of the native path
 *    is that bytes can't be counted per chunk: a completed transfer
 *    delivered the full length, an aborted one some unknown prefix of it.
 *  - A hand-made streamed body is sent chunked with no content-length, so
 *    the browser can't show download size or progress. Declaring the length
 *    via Cloudflare's FixedLengthStream restores that (and makes workerd
 *    error the response if the origin delivers a different byte count).
 *    Node (vitest) doesn't have FixedLengthStream, hence the runtime check.
 */

export interface PumpResult {
  /** True when the origin was fully drained and delivered to the client. */
  completed: boolean;
  durationMs: number;
}

export function trackedStream(
  source: ReadableStream<Uint8Array>,
  contentLength: number | null,
  now: () => number = Date.now,
): {readable: ReadableStream<Uint8Array>; done: Promise<PumpResult>} {
  const identity =
    contentLength !== null && typeof FixedLengthStream === 'function'
      ? new FixedLengthStream(contentLength)
      : new TransformStream<Uint8Array, Uint8Array>();
  const started = now();
  const done = source.pipeTo(identity.writable).then(
    () => ({completed: true, durationMs: now() - started}),
    () => ({completed: false, durationMs: now() - started}),
  );
  return {readable: identity.readable, done};
}
