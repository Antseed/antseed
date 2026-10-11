import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, JsonRpcProvider } from 'ethers';
import { ChannelsClient } from '@antseed/node';
import { readChannelsBatched } from './buyer-channel-control.js';

const CHANNELS = '0x00000000000000000000000000000000000000c1';
const MULTICALL = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)']);
const CHANNEL = new Interface(['function channels(bytes32) view returns (address,address,uint128,uint128,bytes32,uint256,uint256,uint256,uint8)']);
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** Answers aggregate3 with a session for every odd channel id and a revert for even ones. */
class StubProvider extends JsonRpcProvider {
  calls: string[] = [];
  constructor() { super('http://127.0.0.1:1', 8453, { staticNetwork: true }); }
  override async send(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push(method);
    if (method === 'eth_getCode') return '0x60';
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const [calls] = MULTICALL.decodeFunctionData('aggregate3', (params[0] as { data: string }).data) as unknown as [Array<[string, boolean, string]>];
    return MULTICALL.encodeFunctionResult('aggregate3', [calls.map(([target, , data]) => {
      assert.equal(target.toLowerCase(), CHANNELS);
      const n = Number(BigInt(CHANNEL.decodeFunctionData('channels', data)[0] as string));
      if (n % 2 === 0) return [false, '0x'];
      return [true, AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint128', 'uint128', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint8'],
        ['0x00000000000000000000000000000000000000b1', '0x00000000000000000000000000000000000000a1', 5_000_000n * BigInt(n), 1_000_000n, id(0), 9n, 0n, BigInt(n === 3 ? 1234 : 0), n === 3 ? 1 : 2],
      )];
    })]);
  }
}

test('channel statuses are read in one multicall and unreadable rows are left for per-row reads', async () => {
  const provider = new StubProvider();
  const client = new ChannelsClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: CHANNELS, evmChainId: 8453 }).withProvider(provider);
  const sessions = await readChannelsBatched(client.provider, client.contractAddress, [id(1), id(2), id(3)]);

  assert.deepEqual(provider.calls, ['eth_getCode', 'eth_call']);
  assert.deepEqual([...sessions.keys()], [id(1), id(3)]);
  assert.equal(sessions.get(id(1))?.status, 2);
  assert.equal(sessions.get(id(1))?.deposit, 5_000_000n);
  assert.equal(sessions.get(id(3))?.status, 1);
  assert.equal(sessions.get(id(3))?.closeRequestedAt, 1234n);
  assert.equal(sessions.get(id(3))?.seller.toLowerCase(), '0x00000000000000000000000000000000000000a1');
});
