import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStatement, fetchSettlements, periodBounds, periodsSince, statementReference } from './statements.js'

const response = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

test('periods are UTC calendar months', () => {
  assert.deepEqual(periodBounds('2026-12'), { from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) })
  assert.equal(periodBounds('2026-13'), null)
  assert.equal(periodBounds('26-01'), null)
  assert.deepEqual(periodsSince(Date.UTC(2026, 9, 31, 23), Date.UTC(2027, 0, 2)), ['2027-01', '2026-12', '2026-11', '2026-10'])
  assert.deepEqual(periodsSince(Date.UTC(2020, 0, 1), Date.UTC(2027, 0, 2), 2), ['2027-01', '2026-12'])
  assert.equal(statementReference('2026-10', 'ws_ab12cd34'), 'PS-2026-10-12CD34')
})

test('settlements are read page by page and merged per seller and transaction', async () => {
  const pages = [
    { items: [
      { txHash: '0xAA', seller: '0xS1', deltaAmountUsdc: '100', timestamp: 10 },
      { txHash: '0xaa', seller: '0xs1', deltaAmountUsdc: '50', timestamp: 10 }, // the same settlement, another service
    ], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { items: [{ txHash: '0xbb', seller: '0xs2', deltaAmountUsdc: '7', timestamp: 20 }], pageInfo: { hasNextPage: false, endCursor: null } },
  ]
  const asked: Array<Record<string, unknown>> = []
  const settlements = await fetchSettlements('https://explorer.test/', '0xBUYER', 1_000, 2_500, async (input, init) => {
    assert.equal(String(input), 'https://explorer.test/graphql')
    const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }
    asked.push(variables)
    const meta = asked.length === 1 ? { _meta: { status: { base: { id: 8453, block: { number: 5, timestamp: 3 } } } } } : {}
    return response({ data: { ...meta, settlementServices: pages[asked.length - 1] } })
  })
  assert.deepEqual(asked.map((variables) => [variables['buyer'], variables['from'], variables['to'], variables['after']]), [['0xbuyer', 1, 3, null], ['0xbuyer', 1, 3, 'c1']])
  assert.deepEqual(settlements, {
    settlements: [
      { seller: '0xs1', txHash: '0xaa', time: 10_000, amountUsdc: 150 },
      { seller: '0xs2', txHash: '0xbb', time: 20_000, amountUsdc: 7 },
    ],
    indexed: [{ chainId: 8453, at: 3_000 }],
  })
  await assert.rejects(fetchSettlements('https://explorer.test', '0xb', 0, 1, async () => response({ errors: [{ message: 'bad query' }] })), /bad query/)
})

test('a seller paid this month for an earlier month\'s purchases is listed with its settlement and no purchases', () => {
  const seller = '4d'.repeat(20)
  const statement = buildStatement({
    period: '2026-11',
    workspace: { id: 'ws_1', name: 'Default', wallet: null },
    buyer: null,
    lines: [],
    deposits: [],
    peers: new Map(),
    settlements: [{ seller: `0x${seller}`, txHash: `0x${'a1'.repeat(32)}`, time: Date.UTC(2026, 10, 2), amountUsdc: 1_250_000 }],
    settlementsSource: 'https://explorer.test',
    sharedWallet: 0,
    status: 'open',
    now: Date.UTC(2026, 10, 3),
  })
  assert.equal(statement.total, '0.000000')
  assert.equal(statement.suppliers.length, 1)
  assert.equal(statement.suppliers[0]!.peerId, `0x${seller}`)
  assert.deepEqual(statement.suppliers[0]!.lines, [])
  assert.equal(statement.suppliers[0]!.total, '0.000000')
  assert.deepEqual(statement.suppliers[0]!.settlements, [{ txHash: `0x${'a1'.repeat(32)}`, time: Date.UTC(2026, 10, 2), amount: '1.250000' }])
})
