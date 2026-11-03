export interface AuditTaskLimiter {
  run<T>(execute: () => Promise<T>): Promise<T>
}

export class ConcurrencyLimiter implements AuditTaskLimiter {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('concurrency maximum must be an integer >= 1')
  }

  async run<T>(execute: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await execute()
    } finally {
      const waiter = this.waiters.shift()
      if (waiter) waiter()
      else this.active -= 1
    }
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      return
    }
    this.active += 1
  }
}

export class KeyedSerialLimiter {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.tails.set(key, current)
    await previous
    try {
      return await execute()
    } finally {
      release()
      if (this.tails.get(key) === current) this.tails.delete(key)
    }
  }
}

export class SerialOperationQueue {
  private tail = Promise.resolve()

  async run<T>(execute: () => Promise<T>): Promise<T> {
    const result = this.tail.then(execute, execute)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export async function mapConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  execute: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be an integer >= 1')
  const results = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await execute(items[index]!, index)
    }
  }))
  return results
}

export interface AdaptiveConcurrencyControl {
  reduceToOne(): void
}

export async function mapWithAdaptiveConcurrency<T, R>(
  items: readonly T[],
  maximumConcurrency: number,
  execute: (item: T, index: number, control: AdaptiveConcurrencyControl) => Promise<R>,
  shouldPromote: (result: R, index: number) => boolean,
): Promise<R[]> {
  if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
    throw new Error('maximum concurrency must be an integer >= 1')
  }
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let active = 0
  let nextIndex = 0
  let desiredConcurrency = 1
  let permanentlyReduced = false
  let firstFailure: unknown = null

  return await new Promise<R[]>((resolve, reject) => {
    const control: AdaptiveConcurrencyControl = {
      reduceToOne() {
        permanentlyReduced = true
        desiredConcurrency = 1
      },
    }

    const finishOrLaunch = (): void => {
      if (active === 0 && (firstFailure !== null || nextIndex >= items.length)) {
        if (firstFailure !== null) reject(firstFailure)
        else resolve(results)
        return
      }
      if (firstFailure !== null) return

      while (active < desiredConcurrency && nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        active += 1
        void execute(items[index]!, index, control)
          .then((result) => {
            results[index] = result
            if (index === 0 && !permanentlyReduced && shouldPromote(result, index)) {
              desiredConcurrency = maximumConcurrency
            }
          })
          .catch((error: unknown) => {
            firstFailure ??= error
          })
          .finally(() => {
            active -= 1
            finishOrLaunch()
          })
      }
    }

    finishOrLaunch()
  })
}
