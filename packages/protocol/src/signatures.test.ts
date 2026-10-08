/**
 * Golden vectors pin the on-chain-facing encodings: a change to any of these
 * values breaks compatibility with deployed AntseedChannels contracts and
 * existing peers, so the constants below must never change.
 */

import { describe, it, expect } from 'vitest';
import { Wallet, verifyTypedData } from 'ethers';
import {
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  ZERO_METADATA_HASH,
  computeChannelId,
  computeMetadataHash,
  encodeMetadata,
  getServiceMetadataId,
  makeChannelsDomain,
  signSpendingAuth,
  signReserveAuth,
} from './signatures.js';
import { buildConnectionAuthPayload } from './connection-auth.js';
import { signUtf8, verifyUtf8 } from './signing.js';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SELLER = '0x00000000000000000000000000000000000000A1';
const SALT = '0x' + 'ab'.repeat(32);

describe('EIP-712 golden vectors', () => {
  it('pins ZERO_METADATA_HASH', () => {
    expect(ZERO_METADATA_HASH).toBe('0xea67a9fe192b3a98fe0460402ec9f4f1a5a2eaa14cc5bbf0e2ea0eebba976867');
  });

  it('pins channelId derivation', () => {
    expect(computeChannelId(wallet.address, SELLER, SALT)).toBe(
      '0x550a5ddb8b12b28ae000a2d110e0ca0fdeac598034bb7dbaa9189a6c82aae71f',
    );
  });

  it('pins serviceId and metadata hashing', () => {
    expect(getServiceMetadataId('claude-sonnet-5')).toBe(
      '0x2bb26595b5228906bc14e673f9ac6900b2c95af3f70aaba08846209e4db9ed9a',
    );
    const metadata = {
      cumulativeInputTokens: 1234n,
      cumulativeOutputTokens: 567n,
      cumulativeRequestCount: 3n,
      services: [],
    };
    expect(computeMetadataHash(metadata)).toBe(
      '0x37c9aeed7c4a64a210f75b6162b61172843844237cdb69df5275a19fc824d62e',
    );
    // Omitted cumulativeOutputImages encodes identically to an explicit zero.
    expect(computeMetadataHash({ ...metadata, cumulativeOutputImages: 0n })).toBe(
      computeMetadataHash(metadata),
    );
    expect(computeMetadataHash({ ...metadata, cumulativeOutputImages: 2n })).not.toBe(
      computeMetadataHash(metadata),
    );
    expect(computeMetadataHash({
      ...metadata,
      cumulativeVideoGenerations: 0n,
      cumulativeVideoSeconds: 0n,
    })).toBe(computeMetadataHash(metadata));
    expect(computeMetadataHash({
      ...metadata,
      cumulativeVideoGenerations: 1n,
      cumulativeVideoSeconds: 8n,
    })).not.toBe(computeMetadataHash(metadata));
    // Sorted service entries change the hash deterministically.
    const withService = {
      ...metadata,
      services: [{
        serviceId: getServiceMetadataId('claude-sonnet-5'),
        cumulativeAmount: 4200n,
        cumulativeInputTokens: 1234n,
        cumulativeCachedInputTokens: 100n,
        cumulativeOutputTokens: 567n,
        cumulativeRequestCount: 3n,
        cumulativeOutputImages: 2n,
        cumulativeVideoGenerations: 1n,
        cumulativeVideoSeconds: 8n,
      }],
    };
    expect(encodeMetadata(withService)).not.toBe(encodeMetadata(metadata));
  });

  it('produces recoverable SpendingAuth and ReserveAuth signatures', async () => {
    const channelId = computeChannelId(wallet.address, SELLER, SALT);
    const domain = makeChannelsDomain(8453, '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d');

    const spending = { channelId, cumulativeAmount: 123456n, metadataHash: ZERO_METADATA_HASH };
    const spendingSig = await signSpendingAuth(wallet, domain, spending);
    expect(verifyTypedData(domain, SPENDING_AUTH_TYPES, spending, spendingSig)).toBe(wallet.address);

    const reserve = { channelId, maxAmount: 1_000_000n, deadline: 1900000000n };
    const reserveSig = await signReserveAuth(wallet, domain, reserve);
    expect(verifyTypedData(domain, RESERVE_AUTH_TYPES, reserve, reserveSig)).toBe(wallet.address);
  });
});

describe('connection auth signing', () => {
  it('pins the EIP-191 domain-tagged signature', () => {
    expect(signUtf8(wallet, 'hello|abcd|1|00')).toBe(
      'b8de0027c2c06ce84be01846ada3b3ad3efffe2d6d18b3654844d04306404e2b1ec26b922c187a2e3a05d9795ead163ae7dfbfd213bcba3b9d69343897a99dd41b',
    );
  });

  it('round-trips the hello envelope payload', () => {
    const peerId = wallet.address.slice(2).toLowerCase();
    const payload = buildConnectionAuthPayload('hello', peerId, 1754000000000, '00'.repeat(16));
    expect(payload).toBe(`hello|${peerId}|1754000000000|${'00'.repeat(16)}`);
    const sig = signUtf8(wallet, payload);
    expect(verifyUtf8(peerId, payload, sig)).toBe(true);
    expect(verifyUtf8(peerId, payload + 'tampered', sig)).toBe(false);
  });
});
