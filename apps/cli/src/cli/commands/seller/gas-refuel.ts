import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS,
  DEFAULT_REFUEL_SLIPPAGE_BPS,
  DEFAULT_REFUEL_SWAP_USDC_UNITS,
  DEFAULT_REFUEL_TRIGGER_WEI,
  formatEther,
  type GasAutoRefueler,
  type GasRefuelRecord,
} from '@antseed/node'
import type { SellerGasRefuelCLIConfig } from '../../../config/types.js'
import { ethToWei } from './gas.js'

/** Refuels in the last 24 hours, kept so the daily USDC cap holds across restarts. */
export const GAS_REFUEL_HISTORY_FILE = 'gas-refuel.json'

export interface GasRefuelSettings {
  enabled: boolean
  triggerBalanceWei: bigint
  swapUsdcUnits: bigint
  maxUsdcPerDayUnits: bigint
  slippageBps: number
}

const usdcUnits = (usdc: number) => BigInt(Math.round(usdc * 1e6))

export function resolveGasRefuelSettings(cfg: SellerGasRefuelCLIConfig | undefined): GasRefuelSettings {
  return {
    enabled: cfg?.enabled !== false,
    triggerBalanceWei: cfg?.triggerBalanceEth !== undefined ? ethToWei(cfg.triggerBalanceEth) : DEFAULT_REFUEL_TRIGGER_WEI,
    swapUsdcUnits: cfg?.swapUsdc !== undefined ? usdcUnits(cfg.swapUsdc) : DEFAULT_REFUEL_SWAP_USDC_UNITS,
    maxUsdcPerDayUnits: cfg?.maxUsdcPerDay !== undefined ? usdcUnits(cfg.maxUsdcPerDay) : DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS,
    slippageBps: cfg?.slippageBps ?? DEFAULT_REFUEL_SLIPPAGE_BPS,
  }
}

const historyPath = (dataDir: string) => join(dataDir, GAS_REFUEL_HISTORY_FILE)

function isRecord(value: unknown): value is GasRefuelRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['at'] === 'number' && typeof record['usdcUnits'] === 'string' && /^\d+$/.test(record['usdcUnits']) && typeof record['txHash'] === 'string'
    && (record['pending'] === undefined || typeof record['pending'] === 'boolean')
}

/** Past refuels from the data dir; a missing or unreadable file is an empty history. */
export async function loadGasRefuelHistory(dataDir: string): Promise<GasRefuelRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(historyPath(dataDir), 'utf8')) as { refuels?: unknown }
    return Array.isArray(parsed.refuels) ? parsed.refuels.filter(isRecord) : []
  } catch {
    return []
  }
}

export async function saveGasRefuelHistory(dataDir: string, refuels: GasRefuelRecord[]): Promise<void> {
  const path = historyPath(dataDir)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ refuels }, null, 2)}\n`)
  await rename(tmp, path)
}

/** The refueler's state for daemon.state.json (`gas.refuel`), in ETH / USDC numbers (bigint is not JSON). */
export function gasRefuelState(refueler: Pick<GasAutoRefueler, 'getSnapshot'> | null) {
  if (!refueler) return null
  const snapshot = refueler.getSnapshot()
  return {
    triggerBalanceEth: Number(formatEther(snapshot.triggerBalanceWei)),
    swapUsdc: Number(snapshot.swapUsdcUnits) / 1e6,
    maxUsdcPerDay: Number(snapshot.maxUsdcPerDayUnits) / 1e6,
    usdcLast24h: Number(snapshot.usdcLast24hUnits) / 1e6,
    lastRefuel: snapshot.lastRefuel
      ? { at: snapshot.lastRefuel.at, usdc: Number(snapshot.lastRefuel.usdcUnits) / 1e6, txHash: snapshot.lastRefuel.txHash }
      : null,
    lastError: snapshot.lastError,
    skipped: snapshot.skipped,
    nextAttemptAt: snapshot.nextAttemptAt,
  }
}
