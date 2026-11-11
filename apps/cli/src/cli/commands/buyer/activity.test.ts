import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityChannels,
  daemonOnChainChannelState,
  daemonUnaccountedReserve,
  formatChannelLocked,
  normalizeChannelRow,
  type DaemonChannelRow,
} from './activity.js'

const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`

function daemonRow(n: number, status: string, onChain: Record<string, unknown> | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { channelId: id(n), peerId: 'a'.repeat(40), seller: `0x${'51'.repeat(20)}`, buyer: `0x${'b1'.repeat(20)}`, status, cumulativeSigned: '0', reservedAt: n, onChain, ...extra }
}

const open = (deposit: string, settled = '0', closeRequestedAt = 0) => ({ status: 1, deposit, settled, closeRequestedAt, readAt: 1 })

function parse(body: Record<string, unknown>): DaemonChannelRow[] {
  return (body['channels'] as unknown[]).map(normalizeChannelRow).filter((row): row is DaemonChannelRow => row !== null)
}

test('activity lists a channel the buyer retired while the chain holds it open', () => {
  const body = {
    onChain: { readAt: 1, reserved: '3000000', heldByChannels: '3000000', unaccountedReserved: '0' },
    channels: [
      daemonRow(1, 'active', open('1000000', '0'), { cumulativeSigned: '10000' }),
      // The buyer gave up on these sessions; their channels are still open with the reserve locked.
      daemonRow(2, 'ghost', open('1000000', '0'), { cumulativeSigned: '1000000' }),
      daemonRow(3, 'settled', open('1000000', '0', 1_700_000_000)),
      // Closed on-chain though the store still calls it active, and rows that really ended.
      daemonRow(4, 'active', { status: 2, deposit: '1000000', settled: '400000', closeRequestedAt: 0, readAt: 1 }),
      daemonRow(5, 'timeout', { status: 3, deposit: '1000000', settled: '0', closeRequestedAt: 9, readAt: 1 }),
      daemonRow(6, 'ghost', { status: 0, deposit: '0', settled: '0', closeRequestedAt: 0, readAt: 1 }),
    ],
  }
  const rows = parse(body)
  const state = daemonOnChainChannelState(body, rows)
  assert.ok(state)
  const view = activityChannels(rows, state)
  assert.deepEqual(view.rows.map((row) => [row.channelId, view.statusOf(row), formatChannelLocked(state.locked.get(row.channelId))]), [
    [id(3), 'closing', '$1.00 locked'],
    [id(1), 'active', '$0.99 locked'],
    // Signed away in full: nothing is certain to come back, but the chain still holds it.
    [id(2), 'active', '$1.00 unsettled'],
  ])
  // The header matches the buyer's on-chain reserve for these channels, not only what is certain to come back.
  assert.equal(view.held, 3_000_000n)
  assert.equal(view.unreserved, 0)
})

test('activity counts, and does not list, a current row with no on-chain record', () => {
  const body = { onChain: { readAt: 1, reserved: '0', heldByChannels: '0', unaccountedReserved: '0' }, channels: [daemonRow(1, 'active', { status: 0, deposit: '0', settled: '0', closeRequestedAt: 0, readAt: 1 })] }
  const rows = parse(body)
  const view = activityChannels(rows, daemonOnChainChannelState(body, rows)!)
  assert.deepEqual([view.rows.length, view.unreserved, view.held], [0, 1, 0n])
})

test('a row the daemon could not read keeps the status its store gives it', () => {
  const body = { onChain: { readAt: null, reserved: null, heldByChannels: '0', unaccountedReserved: null }, channels: [daemonRow(1, 'active', null), daemonRow(2, 'ghost', null)] }
  const rows = parse(body)
  const state = daemonOnChainChannelState(body, rows)!
  const view = activityChannels(rows, state)
  assert.deepEqual(view.rows.map((row) => row.channelId), [id(1)])
  assert.equal(formatChannelLocked(state.locked.get(id(1))), 'locked amount unavailable')
})

test('a daemon that predates the on-chain records reports none, so the command reads the chain itself', () => {
  const body = { channels: [daemonRow(1, 'active', null)] }
  assert.equal(daemonOnChainChannelState(body, parse(body)), null)
  assert.equal(daemonUnaccountedReserve(body), null)
})

test('the reserve no listed channel accounts for comes from the daemon', () => {
  assert.equal(daemonUnaccountedReserve({ onChain: { unaccountedReserved: '2250000' } }), 2_250_000n)
  assert.equal(daemonUnaccountedReserve({ onChain: { unaccountedReserved: '0' } }), 0n)
  // Not judged (the reserve or a channel was unread).
  assert.equal(daemonUnaccountedReserve({ onChain: { unaccountedReserved: null } }), null)
})

test('formatChannelLocked says nothing is locked only when the chain holds nothing', () => {
  assert.equal(formatChannelLocked({ reserve: 0n, recoverable: 0n }), 'no funds locked')
  assert.equal(formatChannelLocked({ reserve: 250_000n, recoverable: 0n }), '$0.25 unsettled')
  assert.equal(formatChannelLocked({ reserve: 1_000_000n, recoverable: 400_000n }), '$0.40 locked')
})
