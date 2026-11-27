/**
 * Keeps a translated stream alive while the seller is silent. Some sellers write a whole tool call's
 * arguments in one chunk at the end, and a client gives up on a stream that sends nothing for its idle
 * timeout (Codex: 5 minutes, then it sends the whole turn again). After `intervalMs` without a write to
 * the client, this writes the adapter's keep-alive event, an event the client's protocol defines that
 * changes nothing in the answer.
 *
 * It only writes to the client: the seller's stream, and the node's own stall detection on it, are
 * untouched.
 */
export interface StreamKeepAlive {
  /** Something was just written to the client: the silence starts again. */
  touch(): void
  /** The stream ended: nothing more is written. */
  stop(): void
}

export const DEFAULT_STREAM_KEEP_ALIVE_MS = 15_000

export function startStreamKeepAlive(
  keepAlive: () => Uint8Array | null,
  write: (bytes: Uint8Array) => boolean,
  intervalMs: number,
): StreamKeepAlive {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const arm = (): void => {
    clear()
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      if (stopped) return
      const bytes = keepAlive()
      if (bytes && bytes.length > 0 && !write(bytes)) return
      arm()
    }, intervalMs)
    timer.unref?.()
  }

  arm()
  return {
    touch: arm,
    stop() {
      stopped = true
      clear()
    },
  }
}
