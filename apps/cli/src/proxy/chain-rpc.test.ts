import assert from 'node:assert/strict'
import test from 'node:test'
import { Contract, Interface, isError } from 'ethers'
import { startFakeChainRpc } from './chain-rpc-test-support.js'
import { ChainRpcProvider, MULTICALL3_ADDRESS, resetSharedChainProviders, RpcUnavailableError, sharedChainProvider, type RpcTransport } from './chain-rpc.js'

const USDC = '0x' + 'a1'.repeat(20)
const ERC20 = ['function balanceOf(address owner) view returns (uint256)']
const addresses = Array.from({ length: 5 }, (_, index) => '0x' + String(index + 1).padStart(2, '0').repeat(20))

test('identical reads in flight share one request', async (t) => {
  const rpc = await startFakeChainRpc()
  t.after(() => rpc.close())
  const provider = new ChainRpcProvider([rpc.url], 8453)
  t.after(() => provider.destroy())
  // `send` skips ethers' own short-lived result cache, so this exercises the provider's coalescing.
  const read = () => provider.send('eth_getCode', [addresses[0], 'latest']) as Promise<string>
  assert.deepEqual(await Promise.all([read(), read(), read()]), ['0x6080604052', '0x6080604052', '0x6080604052'])
  assert.equal(rpc.requests, 1)
  assert.equal(provider.stats().coalesced, 2)
  await read()
  assert.equal(rpc.requests, 1, 'deployed code is remembered')
})

test('concurrent eth_calls go out as one Multicall3 call', async (t) => {
  const rpc = await startFakeChainRpc()
  t.after(() => rpc.close())
  addresses.forEach((address, index) => rpc.usdc.set(address.toLowerCase(), BigInt(index + 1) * 1_000_000n))
  const provider = new ChainRpcProvider([rpc.url], 8453)
  t.after(() => provider.destroy())
  const usdc = new Contract(USDC, ERC20, provider)
  const read = () => Promise.all(addresses.map((address) => usdc.getFunction('balanceOf').staticCall(address) as Promise<bigint>))
  assert.deepEqual(await read(), [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n, 5_000_000n])
  // One probe for Multicall3's code, then one aggregate3 call.
  assert.deepEqual(rpc.byMethod, { eth_getCode: 1, eth_call: 1 })
  assert.equal(rpc.batchedCalls, 5)
  rpc.reset()
  await read()
  assert.deepEqual(rpc.byMethod, { eth_call: 1 }, 'the Multicall3 code is remembered')
})

test('without Multicall3 the calls are sent one by one', async (t) => {
  const rpc = await startFakeChainRpc({ multicall: false })
  t.after(() => rpc.close())
  const provider = new ChainRpcProvider([rpc.url], 8453)
  t.after(() => provider.destroy())
  const usdc = new Contract(USDC, ERC20, provider)
  await Promise.all(addresses.map((address) => usdc.getFunction('balanceOf').staticCall(address)))
  assert.equal(rpc.byMethod['eth_call'], 5)
})

test('a reverting call inside a batch fails alone, as a CALL_EXCEPTION', async (t) => {
  const multicall = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'])
  const word = (value: bigint) => '0x' + value.toString(16).padStart(64, '0')
  const transport: RpcTransport = async (_url, body) => {
    const request = JSON.parse(body) as { id: number; method: string; params: [{ to: string; data: string }] }
    if (request.method === 'eth_getCode') return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: '0x60' } }
    assert.equal(request.params[0].to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
    const [calls] = multicall.decodeFunctionData('aggregate3', request.params[0].data) as unknown as [unknown[]]
    const results = calls.map((_, index) => index === 1 ? { success: false, returnData: '0x' } : { success: true, returnData: word(7n) })
    return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: multicall.encodeFunctionResult('aggregate3', [results]) } }
  }
  const provider = new ChainRpcProvider(['https://rpc.example.test'], 8453, { transport })
  t.after(() => provider.destroy())
  const usdc = new Contract(USDC, ERC20, provider)
  const settled = await Promise.allSettled(addresses.slice(0, 3).map((address) => usdc.getFunction('balanceOf').staticCall(address)))
  assert.equal(settled[0]!.status, 'fulfilled')
  assert.equal((settled[0] as PromiseFulfilledResult<bigint>).value, 7n)
  assert.equal(settled[1]!.status, 'rejected')
  assert.ok(isError((settled[1] as PromiseRejectedResult).reason, 'CALL_EXCEPTION'))
  assert.equal(settled[2]!.status, 'fulfilled')
})

test('a rate-limited endpoint is skipped for a jittered, growing back-off; then the call fails fast without touching the network', async (t) => {
  const primary = await startFakeChainRpc()
  const fallback = await startFakeChainRpc()
  t.after(() => primary.close())
  t.after(() => fallback.close())
  let now = 1_000_000
  const provider = new ChainRpcProvider([primary.url, fallback.url], 8453, { now: () => now, random: () => 0, backoffBaseMs: 2_000, batchWindowMs: null })
  t.after(() => provider.destroy())

  primary.rateLimit(Number.POSITIVE_INFINITY)
  assert.equal(await provider.getBalance(addresses[0]!), 0n, 'the fallback answers')
  assert.equal(primary.requests, 1)
  assert.equal(fallback.requests, 1)
  await provider.getBalance(addresses[1]!)
  assert.equal(primary.requests, 1, 'the throttling endpoint is not retried while it backs off')
  assert.equal(fallback.requests, 2)

  fallback.rateLimitStyle = 'jsonrpc'
  fallback.rateLimit(Number.POSITIVE_INFINITY)
  now += 5_000 // past the primary's first back-off (2 s base, equal jitter at random()=0 → 1 s)
  await assert.rejects(provider.getBalance(addresses[2]!), (error: unknown) => error instanceof RpcUnavailableError || /rate limiting/.test(String(error)))
  const sent = primary.requests + fallback.requests
  await assert.rejects(provider.getBalance(addresses[3]!), /backing off/)
  assert.equal(primary.requests + fallback.requests, sent, 'refused locally while every endpoint backs off')
  assert.equal(provider.stats().shortCircuited, 1)

  // Second consecutive failure of the primary: 4 s base → at least 2 s.
  const until = provider.unavailableUntil
  assert.ok(until >= now + 1_000)
  primary.rateLimit(0)
  fallback.rateLimit(0)
  now = until + 1
  assert.equal(await provider.getBalance(addresses[4]!), 0n, 'recovers once the back-off passes')
})

test('Retry-After is honoured as the minimum back-off', async (t) => {
  let now = 0
  let calls = 0
  const transport: RpcTransport = async (_url, body) => {
    calls++
    if (calls === 1) return { status: 429, body: null, retryAfterMs: 30_000 }
    return { status: 200, body: { jsonrpc: '2.0', id: JSON.parse(body).id, result: '0x0' } }
  }
  const provider = new ChainRpcProvider(['https://rpc.example.test'], 8453, { transport, now: () => now, random: () => 0, batchWindowMs: null })
  t.after(() => provider.destroy())
  const read = () => provider.send('eth_blockNumber', [])
  await assert.rejects(read())
  now = 29_000
  await assert.rejects(read(), /backing off/)
  assert.equal(calls, 1)
  now = 30_001
  assert.equal(await read(), '0x0')
})

test('one shared provider per chain and endpoint list', () => {
  resetSharedChainProviders()
  const a = sharedChainProvider({ evmChainId: 8453, rpcUrl: 'https://one.example.test', fallbackRpcUrls: ['https://two.example.test'] })
  const b = sharedChainProvider({ evmChainId: 8453, rpcUrl: 'https://one.example.test', fallbackRpcUrls: ['https://two.example.test'] })
  const c = sharedChainProvider({ evmChainId: 8453, rpcUrl: 'https://three.example.test' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  resetSharedChainProviders()
})
