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
  // Six reads plus the provider's one-time Multicall3 code probe, made on the reads' behalf.
  assert.equal(usage['standing']!.total, 7)
  assert.equal(usage['gas']!.total, 1)
  // Six balanceOf reads: one Multicall3 probe and one aggregate3 on the wire.
  assert.equal(rpc.byMethod['eth_call'], 1)
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
