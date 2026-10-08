import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { GatewayAccounting } from './accounting.js'
import { GatewayStore } from './store.js'

/** 500k rows takes ~40 s to fill; `scripts/gateway-admit-benchmark.mjs` runs that size. */
const LEDGER_ROWS = Number(process.env['ANTSEED_ADMIT_BENCH_ROWS'] ?? 50_000)
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Admission must not get slower as the ledger grows: with every period
 * capped at the key, member and workspace level, admit() reads only the
 * spend rollups (one row per scope for the lifetime total, at most 31 daily
 * rows per dated period).
 */
test(`admit() stays under 5 ms with ${LEDGER_ROWS} ledger rows and every cap at every level`, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-admit-bench-'))
  const now = Date.UTC(2026, 9, 28, 12)
  const store = new GatewayStore(dir, () => now)
  try {
    const caps = { daily: 1e12, weekly: 1e12, monthly: 1e12, total: 1e12 }
    const owner = store.createOwner({ label: 'O', email: null })
    store.updateMember(owner.id, { limits: caps })
    const workspace = store.updateWorkspace(store.defaultWorkspace().id, { limits: caps })
    const { key } = store.createKey({ label: 'k', workspaceId: workspace.id, ownerMemberId: owner.id, limits: caps, ownerLimits: caps, expiresAt: null })

    // Half the rows are this key's (the hot path), spread over the last 120
    // days; the rest belong to other keys in the same workspace.
    const insert = store.database.prepare(`
      INSERT INTO ledger_entries (kind, key_id, buyer_identity, amount_usdc, external_ref, created_at, workspace_id, member_id)
      VALUES ('spend', ?, 'default', -1, ?, ?, ?, ?)
    `)
    const fill = performance.now()
    store.database.pragma('cache_size = -262144')
    store.database.transaction(() => {
      for (let index = 0; index < LEDGER_ROWS; index += 1) {
        const mine = index % 2 === 0
        insert.run(mine ? key.id : `key_other_${index % 97}`, `bench:${index}`, now - (index % 120) * DAY_MS - (index % 1000),
          workspace.id, mine ? owner.id : null)
      }
    })()
    t.diagnostic(`filled ${LEDGER_ROWS} ledger rows in ${Math.round(performance.now() - fill)} ms`)

    const accounting = new GatewayAccounting(store, { holdUsdc: 1, now: () => now })
    const fresh = store.getKey(key.id)!
    const context = { member: store.getMember(owner.id), workspace: store.getWorkspace(workspace.id) }
    for (let index = 0; index < 20; index += 1) {
      const warm = accounting.admit(fresh, context)
      if (warm.ok) accounting.release(warm.tag)
    }
    const runs = 500
    const timings: number[] = []
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now()
      const admission = accounting.admit(fresh, context)
      timings.push(performance.now() - started)
      assert.ok(admission.ok)
      if (admission.ok) accounting.release(admission.tag)
    }
    timings.sort((a, b) => a - b)
    const mean = timings.reduce((sum, value) => sum + value, 0) / runs
    const p99 = timings[Math.floor(runs * 0.99)]!
    t.diagnostic(`admit(): mean ${mean.toFixed(3)} ms, p50 ${timings[runs / 2]!.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms`)
    assert.ok(mean < 5, `mean admit() ${mean.toFixed(3)} ms`)

    const spent = store.spendByPeriod({ keyId: key.id }, now)
    assert.equal(spent.total, LEDGER_ROWS / 2)
    accounting.dispose()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
