/** Shared HTTP helpers for the running buyer daemon's control plane. */
import type { DepositWatcherStatus } from '../../../proxy/deposit-watcher.js'
import type { DepositWatcherAbsenceReason } from '../../../proxy/buyer-proxy.js'
import { proxyAuthHeaders } from '../../../proxy/proxy-auth.js'

/** Where the local buyer daemon listens, and the data dir holding its auth token (if any). */
export interface BuyerDaemonTarget {
  port: number
  dataDir: string
}

/** Fetch against the local buyer daemon; null when nothing is listening. */
export async function daemonFetch(
  daemon: BuyerDaemonTarget,
  path: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      ...init,
      headers: { ...headersToRecord(init?.headers), ...proxyAuthHeaders(daemon.dataDir, daemon.port) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }
}

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  return headers ? Object.fromEntries(new Headers(headers).entries()) : {}
}

/** GET a control-plane endpoint as a JSON object; null on any failure. */
export async function daemonJson(daemon: BuyerDaemonTarget, path: string, timeoutMs = 5_000): Promise<Record<string, unknown> | null> {
  const res = await daemonFetch(daemon, path, undefined, timeoutMs)
  if (!res?.ok) return null
  const body = await res.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}

export interface DaemonDepositsStatus {
  watcher: boolean
  /** Why the daemon runs no watcher (null when one is attached, or on older daemons). */
  reason: DepositWatcherAbsenceReason | null
  status: DepositWatcherStatus | null
}

export async function daemonDepositsStatus(daemon: BuyerDaemonTarget): Promise<DaemonDepositsStatus | null> {
  const body = await daemonJson(daemon, '/_antseed/deposits/status', 2_000)
  if (!body || body['ok'] !== true) return null
  return {
    watcher: body['watcher'] === true,
    reason: (body['reason'] ?? null) as DepositWatcherAbsenceReason | null,
    status: (body['status'] ?? null) as DepositWatcherStatus | null,
  }
}

export async function daemonSetWatchMode(daemon: BuyerDaemonTarget, mode: 'active' | 'background'): Promise<boolean> {
  const res = await daemonFetch(daemon, '/_antseed/deposits/watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  }, 5_000)
  const body = await res?.json().catch(() => null) as { ok?: boolean } | null
  return body?.ok === true
}
