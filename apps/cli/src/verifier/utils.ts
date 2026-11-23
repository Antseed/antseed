export function normalized(value: string): string {
  return value.trim().toLowerCase()
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/**
 * Waits for `promise`, or rejects with `message` once `signal` aborts: a queued task never holds its caller past the
 * abort. Without a signal it is the promise itself.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    // The promise is left behind here. Its own rejection (a wait for a slot that the same abort cancels) must be
    // handled, or Node ends the process on it.
    promise.catch(() => undefined)
    return Promise.reject(new Error(message))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(message))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** A seller's peer id as the verifier compares it: lower case, without `0x`. It does not trim. */
export function peerComparisonKey(peerId: string): string {
  return peerId.toLowerCase().replace(/^0x/, '')
}
