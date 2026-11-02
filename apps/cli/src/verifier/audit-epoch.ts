export interface AuditEpochWindow {
  epoch: string
  startedAt: number
  endsAt: number
  source: 'onchain' | 'utc-day'
}

export function utcDayAuditEpochWindow(nowMs: number = Date.now()): AuditEpochWindow {
  const now = new Date(nowMs)
  const startedAtMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return {
    epoch: new Date(startedAtMs).toISOString().slice(0, 10),
    startedAt: startedAtMs / 1_000,
    endsAt: startedAtMs / 1_000 + 24 * 60 * 60,
    source: 'utc-day',
  }
}

export interface OnchainEpochReader {
  currentEpoch(): Promise<number>
  genesis(): Promise<number>
  epochDuration(): Promise<number>
}

export async function onchainAuditEpochWindow(reader: OnchainEpochReader): Promise<AuditEpochWindow> {
  const [epoch, genesis, duration] = await Promise.all([reader.currentEpoch(), reader.genesis(), reader.epochDuration()])
  const startedAt = genesis + epoch * duration
  return { epoch: String(epoch), startedAt, endsAt: startedAt + duration, source: 'onchain' }
}

export interface ResolvedAuditEpoch {
  window: AuditEpochWindow
  warning: string | null
}

export const ONCHAIN_EPOCH_TIMEOUT_MS = 10_000

/**
 * The audit epoch is the on-chain emissions-gate epoch, the same one AntseedKbfVerification checks on
 * submit. Without a reachable chain it falls back to the UTC day and says so; evidence recorded with
 * `source: 'utc-day'` cannot be submitted on-chain.
 */
export async function resolveAuditEpochWindow(
  createReader: () => OnchainEpochReader,
  options: { nowMs?: number; timeoutMs?: number } = {},
): Promise<ResolvedAuditEpoch> {
  const timeoutMs = options.timeoutMs ?? ONCHAIN_EPOCH_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const window = await Promise.race([
      Promise.resolve().then(() => onchainAuditEpochWindow(createReader())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
    return { window, warning: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      window: utcDayAuditEpochWindow(options.nowMs),
      warning: `on-chain epoch unavailable (${message}); using the UTC-day epoch, so this run's evidence cannot be submitted on-chain`,
    }
  } finally {
    clearTimeout(timer)
  }
}
