import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AbstractProvider, AbstractSigner } from 'ethers';
import { ChannelsClient } from './channels-client.js';
import { DepositsClient } from './deposits-client.js';
import { FAILPOINTS, hitFailpoint, hitFailpointSync } from './failpoints.js';
import { PaymentMux } from './payment-mux.js';
import type { BuyerConnection } from './interfaces.js';

const KEY = Symbol.for('antseed.failpoints');
const globals = globalThis as { [KEY]?: unknown };

describe('fail points', () => {
  afterEach(() => { delete globals[KEY]; });

  it('do nothing while no handler is installed', async () => {
    expect(globals[KEY]).toBeUndefined();
    expect(hitFailpointSync('store.before-write')).toBeUndefined();
    const first = hitFailpoint('chain.settle.before-send');
    await expect(first).resolves.toBeUndefined();
    // The fast path allocates nothing: every call returns the same resolved promise.
    expect(hitFailpoint('chain.close.after-receipt')).toBe(first);
  });

  it('call the installed handler with the point name', async () => {
    const hit = vi.fn(async () => {});
    const hitSync = vi.fn();
    globals[KEY] = { hit, hitSync };
    await hitFailpoint('chain.top-up.after-send');
    hitFailpointSync('store.after-write');
    expect(hit.mock.calls).toEqual([['chain.top-up.after-send', undefined]]);
    expect(hitSync.mock.calls).toEqual([['store.after-write', undefined]]);
  });

  it('hand the handler the key of the payment step, and do nothing with it without a handler', async () => {
    const hit = vi.fn(async () => {});
    const hitSync = vi.fn();
    globals[KEY] = { hit, hitSync };
    await hitFailpoint('buyer.spending-auth.after-sign', '0xchannel:1500');
    hitFailpointSync('seller.spending-auth.after-verify', '0xchannel:1500');
    expect(hit.mock.calls).toEqual([['buyer.spending-auth.after-sign', '0xchannel:1500']]);
    expect(hitSync.mock.calls).toEqual([['seller.spending-auth.after-verify', '0xchannel:1500']]);
    delete globals[KEY];
    // A keyed point is as inert as an unkeyed one: the same shared promise, nothing returned.
    expect(hitFailpoint('buyer.spending-auth.after-sign', '0xchannel:1500')).toBe(hitFailpoint('chain.close.after-receipt'));
    expect(hitFailpointSync('seller.spending-auth.after-verify', '0xchannel:1500')).toBeUndefined();
  });

  it('wait for an async handler', async () => {
    let done = false;
    globals[KEY] = { hit: () => new Promise<void>((resolve) => setTimeout(() => { done = true; resolve(); }, 5)), hitSync: () => {} };
    await hitFailpoint('buyer.spending-auth.after-sign');
    expect(done).toBe(true);
  });

  it('pass on an error the handler throws', async () => {
    globals[KEY] = {
      hit: async () => { throw new Error('async boom'); },
      hitSync: () => { throw new Error('sync boom'); },
    };
    await expect(hitFailpoint('chain.reserve.before-send')).rejects.toThrow('async boom');
    expect(() => hitFailpointSync('seller.need-auth.before-send')).toThrow('sync boom');
    // A handler that throws before it returns a promise still rejects, never throws at the call.
    globals[KEY] = { hit: () => { throw new Error('early boom'); }, hitSync: () => {} };
    await expect(hitFailpoint('chain.reserve.before-send')).rejects.toThrow('early boom');
  });

  it('are back to doing nothing once the handler is removed', async () => {
    const hit = vi.fn();
    globals[KEY] = { hit, hitSync: hit };
    delete globals[KEY];
    await hitFailpoint('chain.close.before-send');
    hitFailpointSync('store.before-write');
    expect(hit).not.toHaveBeenCalled();
  });

  it('have unique, well-formed names', () => {
    expect(new Set(FAILPOINTS).size).toBe(FAILPOINTS.length);
    for (const name of FAILPOINTS) expect(name).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
  });

  /** A signer and provider that accept any transaction and mine it at once, recording what happened in order. */
  function fakeChain(log: string[]) {
    const provider = {
      getTransactionCount: async () => 0,
      getBlock: async () => ({ baseFeePerGas: null }),
      getTransactionReceipt: async (hash: string) => { log.push('receipt read'); return { status: 1, hash }; },
    } as unknown as AbstractProvider;
    const signer = {
      provider,
      getAddress: async () => '0x00000000000000000000000000000000000000aa',
      estimateGas: async () => 100_000n,
      sendTransaction: async (tx: { nonce: number }) => { log.push('tx sent'); return { hash: '0x' + '11'.repeat(32), nonce: tx.nonce, from: '0x00000000000000000000000000000000000000aa' }; },
    } as unknown as AbstractSigner;
    return { provider, signer };
  }
  const CHANNEL = '0x' + '22'.repeat(32);
  const ADDRESS = '0x00000000000000000000000000000000000000bb';

  it('a channels transaction reaches its three points around the send and the receipt, in order', async () => {
    const log: string[] = [];
    globals[KEY] = { hit: async (name: string) => { log.push(name); }, hitSync: () => {} };
    const { provider, signer } = fakeChain(log);
    const client = new ChannelsClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: ADDRESS, evmChainId: 31337 }).withProvider(provider);
    const calls: Array<[string, () => Promise<string>]> = [
      ['reserve', () => client.reserve(signer, ADDRESS, CHANNEL, 5n, 9n, '0x')],
      ['top-up', () => client.topUp(signer, CHANNEL, 1n, '0x', '0x', 9n, 9n, '0x')],
      ['settle', () => client.settle(signer, CHANNEL, 1n, '0x', '0x')],
      ['close', () => client.close(signer, CHANNEL, 1n, '0x', '0x')],
      ['request-close', () => client.requestClose(signer, CHANNEL)],
      ['withdraw', () => client.withdraw(signer, CHANNEL)],
    ];
    for (const [op, call] of calls) {
      log.length = 0;
      await call();
      expect(log).toEqual([`chain.${op}.before-send`, 'tx sent', `chain.${op}.after-send`, 'receipt read', `chain.${op}.after-receipt`]);
    }
  });

  it('an error at a chain point stops the write there', async () => {
    const log: string[] = [];
    const { provider, signer } = fakeChain(log);
    const client = new ChannelsClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: ADDRESS, evmChainId: 31338 }).withProvider(provider);
    globals[KEY] = { hit: async (name: string) => { if (name === 'chain.settle.before-send') throw new Error('before'); }, hitSync: () => {} };
    await expect(client.settle(signer, CHANNEL, 1n, '0x', '0x')).rejects.toThrow('before');
    expect(log).toEqual([]);
    globals[KEY] = { hit: async (name: string) => { if (name === 'chain.settle.after-send') throw new Error('after'); }, hitSync: () => {} };
    await expect(client.settle(signer, CHANNEL, 1n, '0x', '0x')).rejects.toThrow('after');
    expect(log).toEqual(['tx sent']);
  });

  it('a write of another contract reaches no point, though its method is called withdraw too', async () => {
    const log: string[] = [];
    globals[KEY] = { hit: async (name: string) => { log.push(name); }, hitSync: (name: string) => { log.push(name); } };
    const { provider, signer } = fakeChain(log);
    const deposits = new DepositsClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: ADDRESS, usdcAddress: ADDRESS, evmChainId: 31339 }).withProvider(provider);
    await deposits.withdraw(signer, ADDRESS, 1n);
    expect(log).toEqual(['tx sent', 'receipt read']);
  });

  it('the buyer reaches a point on each side of every auth frame it sends, by kind', () => {
    const log: string[] = [];
    globals[KEY] = { hit: async () => {}, hitSync: (name: string) => { log.push(name); } };
    const mux = new PaymentMux({ send: () => { log.push('frame sent'); } } as unknown as BuyerConnection);
    const auth = { channelId: CHANNEL, cumulativeAmount: '5', metadataHash: CHANNEL, metadata: '0x', spendingAuthSig: '0x' + '33'.repeat(65) };
    mux.sendSpendingAuth(auth);
    expect(log).toEqual(['buyer.spending-auth.before-send', 'frame sent', 'buyer.spending-auth.after-send']);
    log.length = 0;
    mux.sendSpendingAuth({ ...auth, reserveSalt: CHANNEL, reserveMaxAmount: '100', reserveDeadline: 9 });
    expect(log).toEqual(['buyer.reserve-auth.before-send', 'frame sent', 'buyer.reserve-auth.after-send']);
  });

  it('the points around an auth frame carry the frame\'s channel and cumulative amount as their key', () => {
    const keys: Array<[string, string | undefined]> = [];
    globals[KEY] = { hit: async () => {}, hitSync: (name: string, key?: string) => { keys.push([name, key]); } };
    const mux = new PaymentMux({ send: () => {} } as unknown as BuyerConnection);
    mux.sendSpendingAuth({ channelId: CHANNEL, cumulativeAmount: '5', metadataHash: CHANNEL, metadata: '0x', spendingAuthSig: '0x' + '33'.repeat(65) });
    expect(keys).toEqual([['buyer.spending-auth.before-send', `${CHANNEL}:5`], ['buyer.spending-auth.after-send', `${CHANNEL}:5`]]);
  });
});
