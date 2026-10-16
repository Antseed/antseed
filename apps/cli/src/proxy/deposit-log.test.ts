import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DepositLog } from './deposit-log.js'

const WALLET = `0x${'AB'.repeat(20)}`
const TX = `0x${'a1'.repeat(32)}`

test('records each credited deposit once, per wallet, and skips torn lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-deposit-log-'))
  try {
    const log = new DepositLog(dir)
    await Promise.all([
      log.record(WALLET, { txHash: TX, creditedBaseUnits: '1000000', at: 1 }),
      log.record(WALLET, { txHash: TX.toUpperCase().replace('0X', '0x'), creditedBaseUnits: '1000000', at: 2 }),
    ])
    await log.record(WALLET, { txHash: 'not-a-hash', creditedBaseUnits: '1', at: 3 })
    appendFileSync(join(dir, 'deposits', `${WALLET.toLowerCase()}.jsonl`), '{"txHash":"0x')
    assert.deepEqual(await log.list(WALLET.toLowerCase()), [{ txHash: TX, creditedBaseUnits: '1000000', at: 1 }])
    assert.deepEqual(await log.list(`0x${'cd'.repeat(20)}`), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
