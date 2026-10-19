import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AbiCoder, Interface, type AbstractProvider } from 'ethers'
import type { AntsChainConfig } from '@antseed/ants'
import { readChannelStates } from './wallet-chain.js'

const CANONICAL = `0x${'c1'.repeat(20)}`
const UNDERLYING = `0x${'c2'.repeat(20)}`
const FACADE = `0x${'f1'.repeat(20)}`
const PLAIN_SELLER = `0x${'51'.repeat(20)}`
const CHAIN = { chainId: 'base-mainnet', evmChainId: 8453, rpcUrl: 'http://127.0.0.1:1', channelsContractAddress: CANONICAL } as AntsChainConfig
const CHANNELS = new Interface(['function channels(bytes32) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)'])
const PROBE = new Interface(['function channelsAddress() view returns (address)'])
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`

/** A chain without Multicall3, so every read is a plain eth_call this fake answers. */
function fakeProvider(records: Record<string, Record<string, { deposit: bigint; status: number }>>, opts: { probeFails?: boolean } = {}): AbstractProvider {
  return {
    getCode: async () => '0x',
    call: async ({ to, data }: { to: string; data: string }) => {
      const target = to.toLowerCase()
      if (data.startsWith(PROBE.getFunction('channelsAddress')!.selector)) {
        if (opts.probeFails) throw new Error('rpc timeout')
        return target === FACADE ? AbiCoder.defaultAbiCoder().encode(['address'], [UNDERLYING]) : '0x'
      }
      const [channelId] = CHANNELS.decodeFunctionData('channels', data)
      const record = records[target]?.[channelId as string] ?? { deposit: 0n, status: 0 }
      return CHANNELS.encodeFunctionResult('channels', [CANONICAL, FACADE, record.deposit, 0n, `0x${'00'.repeat(32)}`, 0n, 0n, 0n, record.status])
    },
  } as unknown as AbstractProvider
}

test('readChannelStates reads a channel missing on the canonical contract behind its seller facade', async () => {
  const provider = fakeProvider({ [CANONICAL]: { [id(1)]: { deposit: 5n, status: 1 } }, [UNDERLYING]: { [id(2)]: { deposit: 7n, status: 1 } } })
  const sellers = new Map([[id(2), FACADE], [id(3), PLAIN_SELLER]])
  const states = await readChannelStates(CHAIN, [id(1), id(2), id(3)], sellers, provider)
  assert.equal(states.get(id(1))?.status, 1)
  // Active on the facade's channels contract, so not missing.
  assert.deepEqual([states.get(id(2))?.status, states.get(id(2))?.deposit], [1, 7n])
  // A plain seller has no other contract: the record really is missing.
  assert.equal(states.get(id(3))?.status, 0)
})

test('readChannelStates leaves out a missing channel whose facade could not be checked', async () => {
  const states = await readChannelStates(CHAIN, [id(2)], new Map([[id(2), FACADE]]), fakeProvider({}, { probeFails: true }))
  assert.equal(states.has(id(2)), false)
})
