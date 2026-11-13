import { describe, expect, it } from 'vitest';
import type { BrowserTransaction } from '../../src/browser-signer';
import { WalletPromptGate } from './wallet-prompt';

const address = '0x00000000000000000000000000000000000000ab';
const transaction: BrowserTransaction = { id: 'request-1', jobId: 'job-1', from: address, to: address, data: '0x', value: '0', chainId: 31337 };
const context = {
  transaction, locallyStartedJobIds: new Set(['job-1']), accountAddress: address, accountChainId: 31337,
  walletAddress: address.toUpperCase(), walletChainId: 31337, expectedChainId: 31337, busy: false, settling: false,
};

describe('automatic wallet prompts', () => {
  it('opens each new local request once, including repeated polls or effects', () => {
    const gate = new WalletPromptGate();
    expect(gate.canPrompt(context)).toBe(true);
    expect(gate.claim(context)).toBe(true);
    expect(gate.claim({ ...context, transaction: { ...transaction } })).toBe(false);
    expect(gate.canPrompt(context)).toBe(false);
  });

  it('permits the next transaction of an explicitly initiated multi-step job', () => {
    const gate = new WalletPromptGate();
    expect(gate.claim(context)).toBe(true);
    expect(gate.claim({ ...context, transaction: { ...transaction, id: 'request-2' } })).toBe(true);
  });

  it.each([
    ['another tab', { locallyStartedJobIds: new Set(['other-job']) }],
    ['a tab without restored ownership', { locallyStartedJobIds: new Set<string>() }],
    ['an older backend', { transaction: { ...transaction, jobId: undefined } }],
    ['an opened prompt', { transaction: { ...transaction, approvalStarted: true } }],
    ['a broadcast transaction', { transaction: { ...transaction, submittedHash: '0xabc' } }],
    ['a busy wallet', { busy: true }],
    ['a reconnecting wallet', { settling: true }],
    ['a disconnected wallet', { walletAddress: undefined }],
    ['a changed account', { accountAddress: '0x0000000000000000000000000000000000000001' }],
    ['a stale wallet client', { walletAddress: '0x0000000000000000000000000000000000000001' }],
    ['a changed network', { accountChainId: 8453 }],
    ['a stale wallet network', { walletChainId: 8453 }],
    ['a different dashboard chain', { expectedChainId: 8453 }],
    ['no request', { transaction: null }],
  ] as const)('does not open the wallet for %s', (_label, overrides) => {
    expect(new WalletPromptGate().claim({ ...context, ...overrides })).toBe(false);
  });

  it('waits for the right account rather than consuming the request early', () => {
    const gate = new WalletPromptGate();
    expect(gate.claim({ ...context, walletAddress: undefined })).toBe(false);
    expect(gate.claim(context)).toBe(true);
  });

  it('never automatically retries the same request after a failed or rejected prompt', () => {
    const gate = new WalletPromptGate();
    expect(gate.claim(context)).toBe(true);
    expect(gate.claim({ ...context, busy: true })).toBe(false);
    expect(gate.claim({ ...context, busy: false })).toBe(false);
  });

  it('automatically resumes an unopened request when the tab restores its job ownership', () => {
    const restored = { ...context, locallyStartedJobIds: new Set(['job-1']) };
    expect(new WalletPromptGate().claim(restored)).toBe(true);
    expect(new WalletPromptGate().claim({ ...restored, transaction: { ...transaction, approvalStarted: true } })).toBe(false);
  });
});
