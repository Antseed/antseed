import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GAS_REFUEL_HISTORY_FILE, loadGasRefuelHistory, resolveGasRefuelSettings, saveGasRefuelHistory } from './gas-refuel.js'

test('gas refuel settings default on, and config values convert to wei and USDC units', () => {
  assert.deepEqual(resolveGasRefuelSettings(undefined), {
    enabled: true, triggerBalanceWei: 500_000_000_000_000n, swapUsdcUnits: 10_000_000n, maxUsdcPerDayUnits: 30_000_000n, slippageBps: 100,
  })
  assert.deepEqual(resolveGasRefuelSettings({ enabled: false, triggerBalanceEth: 0.001, swapUsdc: 2.5, maxUsdcPerDay: 12, slippageBps: 50 }), {
    enabled: false, triggerBalanceWei: 1_000_000_000_000_000n, swapUsdcUnits: 2_500_000n, maxUsdcPerDayUnits: 12_000_000n, slippageBps: 50,
  })
})

test('refuel history round-trips through the data dir and ignores a corrupt file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas-refuel-'))
  assert.deepEqual(await loadGasRefuelHistory(dir), [])
  const refuels = [{ at: 1, usdcUnits: '10000000', txHash: '0xabc' }]
  await saveGasRefuelHistory(dir, refuels)
  assert.deepEqual(await loadGasRefuelHistory(dir), refuels)
  writeFileSync(join(dir, GAS_REFUEL_HISTORY_FILE), '{ not json')
  assert.deepEqual(await loadGasRefuelHistory(dir), [])
  writeFileSync(join(dir, GAS_REFUEL_HISTORY_FILE), JSON.stringify({ refuels: [{ at: 'x' }, ...refuels] }))
  assert.deepEqual(await loadGasRefuelHistory(dir), refuels)
})
