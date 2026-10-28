import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkVatNumber, fetchEurRate, fetchSettlements, normalizeVatNumber, periodBounds, periodsSince, rateDate, statementReference } from './statements.js'

const response = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

test('periods are UTC calendar months', () => {
  assert.deepEqual(periodBounds('2026-12'), { from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) })
  assert.equal(periodBounds('2026-13'), null)
  assert.equal(periodBounds('26-01'), null)
  assert.deepEqual(periodsSince(Date.UTC(2026, 9, 31, 23), Date.UTC(2027, 0, 2)), ['2027-01', '2026-12', '2026-11', '2026-10'])
  assert.deepEqual(periodsSince(Date.UTC(2020, 0, 1), Date.UTC(2027, 0, 2), 2), ['2027-01', '2026-12'])
  assert.equal(rateDate('2026-10', Date.UTC(2026, 9, 15, 12)), '2026-10-15')
  assert.equal(rateDate('2026-10', Date.UTC(2027, 0, 1)), '2026-10-31')
  assert.equal(statementReference('2026-10', 'ws_ab12cd34'), 'PS-2026-10-12CD34')
})

test('the ECB rate is read from its CSV answer', async () => {
  let url = ''
  const rate = await fetchEurRate('2026-10-31', async (input) => {
    url = String(input)
    return response('KEY,FREQ,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,2026-10-30,1.1612\n')
  })
  assert.deepEqual(rate, { usdPerEur: 1.1612, date: '2026-10-30' })
  assert.match(url, /endPeriod=2026-10-31&lastNObservations=1/)
  await assert.rejects(fetchEurRate('2026-10-31', async () => response('KEY,TIME_PERIOD,OBS_VALUE\n')))
})

test('VIES checks EU numbers only and says null when it cannot answer', async () => {
  assert.equal(normalizeVatNumber('nl 0000.00000-b01'), 'NL000000000B01')
  const urls: string[] = []
  const vies = (body: unknown, status = 200) => async (input: string | URL | Request) => { urls.push(String(input)); return response(body, status) }
  assert.equal(await checkVatNumber('NL000000000B01', vies({ isValid: true, userError: 'VALID' })), true)
  assert.match(urls[0]!, /\/ms\/NL\/vat\/000000000B01$/)
  assert.equal(await checkVatNumber('NL000000000B01', vies({ isValid: false, userError: 'INVALID' })), false)
  assert.equal(await checkVatNumber('NL000000000B01', vies({ isValid: false, userError: 'MS_UNAVAILABLE' })), null)
  assert.equal(await checkVatNumber('NL000000000B01', vies({}, 500)), null)
  assert.equal(await checkVatNumber('GB123456789', vies({ isValid: true })), null, 'not an EU number: nothing to check')
  assert.equal(urls.length, 4)
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
    return response({ data: { settlementServices: pages[asked.length - 1] } })
  })
  assert.deepEqual(asked.map((variables) => [variables['buyer'], variables['from'], variables['to'], variables['after']]), [['0xbuyer', 1, 3, null], ['0xbuyer', 1, 3, 'c1']])
  assert.deepEqual(settlements, [
    { seller: '0xs1', txHash: '0xaa', time: 10_000, amountUsdc: 150 },
    { seller: '0xs2', txHash: '0xbb', time: 20_000, amountUsdc: 7 },
  ])
  await assert.rejects(fetchSettlements('https://explorer.test', '0xb', 0, 1, async () => response({ errors: [{ message: 'bad query' }] })), /bad query/)
})
