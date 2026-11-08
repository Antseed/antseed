import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import {
  SPENDING_AUTH_TYPES,
  makeChannelsDomain,
  signSpendingAuth,
  computeMetadataHash,
  ZERO_METADATA_HASH,
  type SpendingAuthMessage,
} from '../src/payments/evm/signatures.js';
import { loadOrCreateIdentity } from '../src/p2p/identity.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('EIP-712 Contract Compatibility', () => {
  it('SPENDING_AUTH_TYPES typehash matches contract format', () => {
    // The contract computes:
    // keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)")
    const expectedTypeString =
      'SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)';
    const expectedHash = keccak256(toUtf8Bytes(expectedTypeString));

    // Verify our TS type definition produces the same encoding
    const fields = SPENDING_AUTH_TYPES.SpendingAuth;
    const tsTypeString = `SpendingAuth(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
    const tsHash = keccak256(toUtf8Bytes(tsTypeString));

    expect(tsHash).toBe(expectedHash);
  });

  it('TS SpendingAuth type string has exactly the right field order and types', () => {
    const fields = SPENDING_AUTH_TYPES.SpendingAuth;
    expect(fields).toHaveLength(3);
    expect(fields[0]).toEqual({ name: 'channelId', type: 'bytes32' });
    expect(fields[1]).toEqual({ name: 'cumulativeAmount', type: 'uint256' });
    expect(fields[2]).toEqual({ name: 'metadataHash', type: 'bytes32' });
  });

  it('Antseed domain version is "1" matching contract constructor', () => {
    const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(domain.name).toBe('AntseedChannels');
    expect(domain.version).toBe('1');
    expect(domain.chainId).toBe(31337);
    expect(domain.verifyingContract).toBe('0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
  });

  it('domain separator is deterministic for same inputs', () => {
    const d1 = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    const d2 = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(d1).toEqual(d2);
  });

  it('different chain IDs produce different domains', () => {
    const local = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    const base = makeChannelsDomain(8453, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(local.chainId).not.toBe(base.chainId);
  });

  it('reserve SpendingAuth (cumulative=0) signs and recovers correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const msg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 0n,
        metadataHash: ZERO_METADATA_HASH,
      };

      const sig = await signSpendingAuth(wallet, domain, msg);
      const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('settle SpendingAuth (cumulative>0) signs and recovers correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const msg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 500000n,
        metadataHash: computeMetadataHash({ cumulativeInputTokens: 5000n, cumulativeOutputTokens: 12000n, cumulativeRequestCount: 0n }),
      };

      const sig = await signSpendingAuth(wallet, domain, msg);
      const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('different cumulative amounts produce different SpendingAuth signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const baseMsg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: computeMetadataHash({ cumulativeInputTokens: 1000n, cumulativeOutputTokens: 2000n, cumulativeRequestCount: 0n }),
      };

      const sig1 = await signSpendingAuth(wallet, domain, baseMsg);
      const sig2 = await signSpendingAuth(wallet, domain, {
        ...baseMsg,
        cumulativeAmount: 200000n,
      });
      expect(sig1).not.toBe(sig2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('different channel IDs produce different signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const baseMsg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: ZERO_METADATA_HASH,
      };

      const sig1 = await signSpendingAuth(wallet, domain, baseMsg);
      const sig2 = await signSpendingAuth(wallet, domain, {
        ...baseMsg,
        channelId: '0x' + '02'.repeat(32),
      });
      expect(sig1).not.toBe(sig2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wrong signer is not recovered from signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity1 = await loadOrCreateIdentity(dir);
      const wallet1 = identity1.wallet;

      // Create a second identity in a different dir
      const dir2 = await mkdtemp(join(tmpdir(), 'eip712-test2-'));
      const identity2 = await loadOrCreateIdentity(dir2);
      const wallet2 = identity2.wallet;

      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
      const msg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: ZERO_METADATA_HASH,
      };

      // Sign with wallet1
      const sig = await signSpendingAuth(wallet1, domain, msg);
      // Recover and check it does NOT match wallet2
      const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet1.address.toLowerCase());
      expect(recovered.toLowerCase()).not.toBe(wallet2.address.toLowerCase());

      await rm(dir2, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
