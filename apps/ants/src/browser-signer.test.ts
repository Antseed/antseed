import { describe, expect, it, vi } from 'vitest';
import { type Provider, type TransactionResponse } from 'ethers';
import { BrowserSigning } from './browser-signer.js';
import { WALLET_ERRORS } from './wallet-errors.js';
const from = '0x0000000000000000000000000000000000000001';
const to = '0x0000000000000000000000000000000000000002';
const hash = `0x${'ab'.repeat(32)}`;
function fixture(overrides: object = {}) {
  const tx = { from, to, chainId: 31337n, data: '0x1234', value: 2n, nonce: 4, hash, ...overrides } as TransactionResponse;
  const provider = { call: vi.fn(async () => '0x'), getTransactionCount: async () => 4, getNetwork: async () => ({ chainId: 31337n }), getTransaction: async () => tx, waitForTransaction: async () => ({ status: 1, logs: [] }), getCode: async () => '0x' } as unknown as Provider;
  const bridge = new BrowserSigning(31337);
  return { bridge, signer: bridge.signer(from, provider), provider, tx };
}
describe('browser signer', () => {
  it('waits for the browser and verifies the transaction before resolving', async () => {
    const { bridge, signer, tx } = fixture();
    const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
    await vi.waitFor(() => expect(bridge.request).not.toBeNull());
    await expect(bridge.complete('wrong-id', hash)).rejects.toThrow('no longer active');
    await bridge.complete(bridge.request!.id, hash);
    expect(await sent).toBe(tx);
  });
  for (const bad of [{ from: to }, { to: from }, { data: '0x5678' }, { value: 3n }, { chainId: 1n }, { nonce: 3 }]) {
    it(`rejects a mismatched ${Object.keys(bad)[0]}`, async () => {
      const { bridge, signer } = fixture(bad);
      const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
      const rejected = expect(sent).rejects.toThrow('does not match');
      await vi.waitFor(() => expect(bridge.request).not.toBeNull());
      await bridge.complete(bridge.request!.id, hash);
      await rejected;
    });
  }
  it('accepts an EIP-7702 smart account routing the call through its delegation framework', async () => {
    const delegationManager = '0x0000000000000000000000000000000000000003';
    const { bridge, signer, provider, tx } = fixture({ to: delegationManager, data: '0xcef6d209' });
    provider.getCode = vi.fn(async () => '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b');
    provider.waitForTransaction = vi.fn(async () => ({ status: 1, logs: [{ address: delegationManager }, { address: to }] })) as never;
    const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
    await vi.waitFor(() => expect(bridge.request).not.toBeNull());
    await bridge.complete(bridge.request!.id, hash);
    expect(await sent).toBe(tx);
  });
  it('rejects a delegated account transaction that never reached the reviewed contract', async () => {
    const { bridge, signer, provider } = fixture({ to: '0x0000000000000000000000000000000000000003', data: '0xcef6d209' });
    provider.getCode = vi.fn(async () => '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b');
    provider.waitForTransaction = vi.fn(async () => ({ status: 1, logs: [{ address: '0x0000000000000000000000000000000000000003' }] })) as never;
    const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
    const rejected = expect(sent).rejects.toThrow('does not match');
    await vi.waitFor(() => expect(bridge.request).not.toBeNull());
    await bridge.complete(bridge.request!.id, hash);
    await rejected;
  });
  it('cancels unsigned work and invalidates old signer references', async () => {
    const { bridge, signer } = fixture();
    const sent = signer.sendTransaction({ to });
    const rejected = expect(sent).rejects.toThrow('changed');
    await vi.waitFor(() => expect(bridge.request).not.toBeNull());
    bridge.cancel(); await rejected;
    await expect(signer.sendTransaction({ to })).rejects.toThrow('changed');
  });
  it('keeps broadcast transactions tracked when the wallet disconnects', async () => {
    const { bridge, signer, provider } = fixture();
    let confirmed!: (receipt: { status: number }) => void;
    provider.waitForTransaction = vi.fn(() => new Promise(resolve => { confirmed = resolve as typeof confirmed; }));
    const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
    await vi.waitFor(() => expect(bridge.request).not.toBeNull());
    const id = bridge.request!.id;
    await bridge.complete(id, hash);
    bridge.cancel(); expect(bridge.request?.submittedHash).toBe(hash);
    await bridge.complete(id, hash); // duplicate acknowledgment cannot broadcast twice
    confirmed({ status: 1 }); await sent;
    await expect(signer.sendTransaction({ to })).rejects.toThrow('changed');
  });
  it('does not request wallet approval after a failed simulation', async () => {
    const { bridge, signer, provider } = fixture();
    provider.call = vi.fn(async () => { throw new Error('Contract reverted'); });
    await expect(signer.sendTransaction({ to })).rejects.toThrow('Contract reverted');
    expect(bridge.request).toBeNull();
  });
});

it('reserves approval across tabs and reconciles a broadcast after an account switch', async () => {
  const { bridge, signer, tx } = fixture();
  const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
  await vi.waitFor(() => expect(bridge.request).not.toBeNull());
  const id = bridge.request!.id;
  bridge.begin(id);
  expect(() => bridge.begin(id)).toThrow('already being approved');
  bridge.cancel(); // account event can arrive before the wallet returns its hash
  expect(bridge.request?.id).toBe(id);
  await bridge.complete(id, hash);
  expect(await sent).toBe(tx);
  await expect(signer.sendTransaction({ to })).rejects.toThrow('changed');
});

it('does not advance a job when the submitted transaction reverted', async () => {
  const { bridge, signer, provider } = fixture();
  provider.waitForTransaction = vi.fn(async () => ({ status: 0 })) as never;
  const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
  const rejected = expect(sent).rejects.toThrow('Transaction failed');
  await vi.waitFor(() => expect(bridge.request).not.toBeNull());
  await bridge.complete(bridge.request!.id, hash);
  await rejected;
});

it('keeps polling through an ethers TIMEOUT and tolerates a lagging endpoint on the read-back', async () => {
  const { bridge, signer, provider, tx } = fixture();
  const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
  provider.waitForTransaction = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce({ status: 1 }) as never;
  provider.getTransaction = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(tx) as never;
  const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
  await vi.waitFor(() => expect(bridge.request).not.toBeNull());
  await bridge.complete(bridge.request!.id, hash);
  expect(await sent).toBe(tx);
  expect(provider.waitForTransaction).toHaveBeenCalledTimes(2);
  expect(provider.getTransaction).toHaveBeenCalledTimes(2);
}, 15_000);

it('rejects a wallet cancellation after the prompt was opened so a reloaded tab is not stuck', async () => {
  const { bridge, signer } = fixture();
  const sent = signer.sendTransaction({ to, data: '0x1234', value: 2n });
  const rejected = expect(sent).rejects.toThrow(WALLET_ERRORS.rejected);
  await vi.waitFor(() => expect(bridge.request).not.toBeNull());
  const id = bridge.request!.id;
  bridge.begin(id);
  await bridge.complete(id, undefined, WALLET_ERRORS.rejected);
  await rejected;
  expect(bridge.request).toBeNull();
});
