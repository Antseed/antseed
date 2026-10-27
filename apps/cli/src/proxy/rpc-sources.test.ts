import assert from 'node:assert/strict'
import test from 'node:test'
import { Contract } from 'ethers'
import { startFakeChainRpc } from './chain-rpc-test-support.js'
import { ChainRpcProvider } from './chain-rpc.js'
import { recordRpcCall, resetRpcUsage, rpcUsage, withRpcSource } from './rpc-sources.js'

const USDC = '0x' + 'a1'.repeat(20)
const addresses = Array.from({ length: 6 }, (_, index) => '0x' + String(index + 1).padStart(2, '0').repeat(20))

test('calls are counted per source across awaits, while the wire sees one batched request', async (t) => {
  resetRpcUsage()
  const rpc = await startFakeChainRpc()
  t.after(() => rpc.close())
  const provider = new ChainRpcProvider([rpc.url], 8453)
  t.after(() => provider.destroy())
  const usdc = new Contract(USDC, ['function balanceOf(address owner) view returns (uint256)'], provider)
  await withRpcSource('standing', async () => {
    await Promise.resolve()
    await Promise.all(addresses.map((address) => usdc.getFunction('balanceOf').staticCall(address)))
  })
  await withRpcSource('gas', () => provider.getBalance(addresses[0]!))
  const usage = rpcUsage()
  assert.equal(usage['standing']!.total, 6)
  assert.equal(usage['gas']!.total, 1)
  // The provider's one-time Multicall3 code probe is its own source.
  assert.equal(usage['multicall-probe']!.total, 1)
  // Six balanceOf reads: one Multicall3 probe and one aggregate3 on the wire.
  assert.equal(rpc.byMethod['eth_call'], 1)
})

test('concurrent reads from two sources are each counted for their own source', async (t) => {
  resetRpcUsage()
  const rpc = await startFakeChainRpc()
  t.after(() => rpc.close())
  const provider = new ChainRpcProvider([rpc.url], 8453)
  t.after(() => provider.destroy())
  const usdc = new Contract(USDC, ['function balanceOf(address owner) view returns (uint256)'], provider)
  // Both enqueue before ethers' shared drain timer fires.
  await Promise.all([
    withRpcSource('standing', () => usdc.getFunction('balanceOf').staticCall(addresses[0]!)),
    withRpcSource('gas', () => provider.getBalance(addresses[1]!)),
    withRpcSource('gas', () => provider.getBalance(addresses[2]!)),
  ])
  const usage = rpcUsage()
  assert.equal(usage['standing']!.total, 1)
  assert.equal(usage['gas']!.total, 2)
})

test('the per-minute rate covers the last ten full minutes', () => {
  resetRpcUsage()
  const minute = 60_000
  const now = 100 * minute + 30_000
  for (let index = 0; index < 20; index++) recordRpcCall('market', now - minute)
  recordRpcCall('market', now)
  const usage = rpcUsage(now)['market']!
  assert.deepEqual([usage.total, usage.lastMinute, usage.perMinute], [21, 20, 2])
})
