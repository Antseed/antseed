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
