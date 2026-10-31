import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MIN_POLL_SECONDS, acquireDaemonLock, parsePollInterval } from './daemon-setup.js'

test('--interval must be a finite number of seconds within the timer range', () => {
  assert.equal(parsePollInterval(undefined), 60_000)
  assert.equal(parsePollInterval('90'), 90_000)
  assert.equal(parsePollInterval('2'), MIN_POLL_SECONDS * 1_000, 'raised to the minimum')
  for (const bad of ['60s', '', ' ', 'Infinity', 'NaN', '1e10']) {
    assert.throws(() => parsePollInterval(bad), /--interval must be a number of seconds/, bad)
  }
})

test('a second daemon on the same data dir is refused until the first releases it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-daemon-lock-'))
  try {
    const first = await acquireDaemonLock(dataDir)
    await assert.rejects(acquireDaemonLock(dataDir), /already running with the data dir/)
    await first.release()
    const second = await acquireDaemonLock(dataDir)
    await second.release()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
