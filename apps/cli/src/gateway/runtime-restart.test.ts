import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { startGatewayRuntime } from './runtime.js'
import { GatewayStore } from './store.js'
import { videoJobKey, videoReservationKey } from './video-jobs.js'

const VIDEO_CREATE_PATH = '/api/v1/video/queue'

function runtimeOptions(dataDir: string, listenPort = 0) {
  // Nothing listens on the buyer port: the spend feed and buyer calls just fail.
  return { dataDir, configPath: join(dataDir, 'config.json'), listenPort, buyerPort: 1 }
}

test('a gateway restarted after a crash recovers an accepted video at its logged price and ends the old run\'s requests', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'antseed-gateway-restart-'))
  try {
    // What a gateway left when it stopped between the buyer accepting a video and storing the job's commitment:
    // the create's reservation (the whole $1 room), the create logged with its job and the buyer's $0.40 price,
    // and a chat request still in flight.
    const crashed = new GatewayStore(dataDir)
    const { key } = crashed.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
    const startedAt = Date.now() - 60_000
    crashed.startRequest({ tag: 'old-chat', keyId: key.id, buyerIdentity: key.buyerIdentity, method: 'POST', path: '/v1/chat/completions', model: 'm', startedAt })
    crashed.startRequest({ tag: 'old-create', keyId: key.id, buyerIdentity: key.buyerIdentity, method: 'POST', path: VIDEO_CREATE_PATH, model: 'seedance', startedAt, video: { action: 'create', jobId: null } })
    crashed.recordRequestOutcome('old-create', { videoJobId: 'job-1', videoPriceUsdc: 400_000 })
    crashed.saveVideoCommitment({
      job: videoReservationKey('old-create'), keyId: key.id, memberId: key.ownerMemberId, workspaceId: key.workspaceId,
      amountUsdc: 1_000_000, expiresAt: Date.now() + 86_400_000, deliveredAt: null,
    })
    crashed.close()

    const runtime = await startGatewayRuntime(runtimeOptions(dataDir))
    try {
      const commitments = runtime.store.listVideoCommitments(Date.now())
      assert.deepEqual(commitments.map(({ job, amountUsdc }) => ({ job, amountUsdc })), [{ job: videoJobKey('venice-video', 'job-1'), amountUsdc: 400_000 }],
        'the reservation became the job, at the price the buyer reported')
      const rows = runtime.store.database.prepare('SELECT tag, status, error_code, finished_at IS NOT NULL AS finished FROM gateway_requests ORDER BY tag').all()
      assert.deepEqual(rows, [
        { tag: 'old-chat', status: 499, error_code: 'gateway_restarted', finished: 1 },
        { tag: 'old-create', status: 499, error_code: 'gateway_restarted', finished: 1 },
      ])
      assert.equal(runtime.store.unfinishedRequestCount(key.id), 0)
    } finally {
      await runtime.stop()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a gateway that cannot take its port leaves the running gateway\'s requests in flight', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'antseed-gateway-restart-'))
  try {
    const seed = new GatewayStore(dataDir)
    const { key } = seed.createKey({ label: 'Chat', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
    seed.close()
    const running = await startGatewayRuntime(runtimeOptions(dataDir))
    try {
      // A request the running gateway has in flight, started before the second one starts.
      running.store.startRequest({ tag: 'live', keyId: key.id, buyerIdentity: key.buyerIdentity, method: 'POST', path: '/v1/chat/completions', model: 'm', startedAt: Date.now() - 1_000 })
      await assert.rejects(startGatewayRuntime(runtimeOptions(dataDir, running.port)), /EADDRINUSE/)
      const row = running.store.database.prepare("SELECT status, finished_at FROM gateway_requests WHERE tag = 'live'").get()
      assert.deepEqual(row, { status: null, finished_at: null }, 'still in flight')
    } finally {
      await running.stop()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
