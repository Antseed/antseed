/**
 * Golden vectors pin the on-chain-facing encodings: a change to any of these
 * values breaks compatibility with deployed AntseedChannels contracts and
 * existing peers, so the constants below must never change. The exception is
 * metadata hashed by the current encoder, which changes only with a
 * METADATA_VERSION bump; the previous version's bytes stay pinned below.
 */

import { describe, it, expect } from 'vitest';
import { AbiCoder, TypedDataEncoder, Wallet, keccak256, verifyTypedData } from 'ethers';
import {
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  ZERO_METADATA_HASH,
  computeChannelId,
  computeMetadataHash,
  decodeSpendingAuthMetadata,
  encodeMetadata,
  METADATA_VERSION,
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
  // Changes only with METADATA_VERSION (v5 here); see the version goldens below.
  it('pins ZERO_METADATA_HASH', () => {
    expect(ZERO_METADATA_HASH).toBe('0xdb2975dcc121adbd49379a0095b05556acdf01593802587e93980a3758a35f42');
  });

  it('pins the SpendingAuth EIP-712 digest', () => {
    const domain = makeChannelsDomain(8453, '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d');
    expect(TypedDataEncoder.hash(domain, SPENDING_AUTH_TYPES, {
      channelId: '0x' + '11'.repeat(32),
      cumulativeAmount: 123456n,
      metadataHash: '0x' + '22'.repeat(32),
    })).toBe('0x5b8a1cc748fb2ea9e1aba9675824ad01aac67698735df444c9aef19a3f7724db');
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
    expect(computeMetadataHash(metadata)).toBe('0x5061385bd4dce04398e6999fc5c92c3c50509831c99867fa5392d9fb9e1a4ffd');
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
    expect(computeMetadataHash({ ...metadata, cumulativeInputCharacters: 0n })).toBe(computeMetadataHash(metadata));
    expect(computeMetadataHash({ ...metadata, cumulativeInputCharacters: 19n })).not.toBe(computeMetadataHash(metadata));
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

// One channel's usage: a chat model and a video model (v4 fields only).
const usageFixture = {
  cumulativeInputTokens: 1234n,
  cumulativeOutputTokens: 567n,
  cumulativeRequestCount: 3n,
  cumulativeOutputImages: 2n,
  cumulativeVideoGenerations: 1n,
  cumulativeVideoSeconds: 8n,
  services: [
    { serviceId: getServiceMetadataId('model-a'), cumulativeAmount: 4200n, cumulativeInputTokens: 1000n, cumulativeCachedInputTokens: 100n, cumulativeOutputTokens: 500n, cumulativeRequestCount: 1n, cumulativeOutputImages: 0n, cumulativeVideoGenerations: 0n, cumulativeVideoSeconds: 0n },
    { serviceId: getServiceMetadataId('video-b'), cumulativeAmount: 9000n, cumulativeInputTokens: 234n, cumulativeCachedInputTokens: 0n, cumulativeOutputTokens: 67n, cumulativeRequestCount: 2n, cumulativeOutputImages: 2n, cumulativeVideoGenerations: 1n, cumulativeVideoSeconds: 8n },
  ],
};

/** v4 as buyers that have not upgraded still sign it: v5 without the character counters. */
function encodeMetadataV4(metadata: typeof usageFixture): string {
  return AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256',
      'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeOutputImages,uint256 cumulativeVideoGenerations,uint256 cumulativeVideoSeconds)[]'],
    [4n, metadata.cumulativeInputTokens, metadata.cumulativeOutputTokens, metadata.cumulativeRequestCount,
      metadata.cumulativeOutputImages, metadata.cumulativeVideoGenerations, metadata.cumulativeVideoSeconds,
      [...metadata.services].sort((a, b) => (a.serviceId < b.serviceId ? -1 : 1))],
  );
}

describe('SpendingAuth metadata versions', () => {
  // The v4 hash is of the bytes the v4 encoder produced before v5 existed.
  it('pins the v4 bytes buyers that have not upgraded still sign', () => {
    expect(keccak256(encodeMetadataV4(usageFixture))).toBe('0x432fe5129eb1920b99922b565b4595e0743921fa496def63e438baac070cc758');
  });

  it('pins the v5 bytes, with speech characters at the top level and per service', () => {
    const v5 = {
      ...usageFixture,
      cumulativeInputCharacters: 19n,
      services: [
        ...usageFixture.services,
        { serviceId: getServiceMetadataId('tts-c'), cumulativeAmount: 285n, cumulativeInputTokens: 0n, cumulativeCachedInputTokens: 0n, cumulativeOutputTokens: 0n, cumulativeRequestCount: 1n, cumulativeOutputImages: 0n, cumulativeVideoGenerations: 0n, cumulativeVideoSeconds: 0n, cumulativeInputCharacters: 19n },
      ],
    };
    expect(METADATA_VERSION).toBe(5n);
    expect(computeMetadataHash(v5)).toBe('0x476d90d80c4dce9ada1410049e54c94c119ae484fd9d1ea79aa71c46a209a435');
  });

  it('round-trips v5 and keeps the leading words where v4 has them', () => {
    const v5 = {
      ...usageFixture,
      cumulativeInputCharacters: 19n,
      services: usageFixture.services.map((service, index) => ({ ...service, cumulativeInputCharacters: BigInt(index * 7) })),
    };
    const encoded = encodeMetadata(v5);
    const decoded = decodeSpendingAuthMetadata(encoded);
    expect(decoded.version).toBe(5n);
    const byId = (a: { serviceId: string }, b: { serviceId: string }) => (a.serviceId < b.serviceId ? -1 : 1);
    expect(decoded).toEqual({ version: 5n, ...v5, services: [...v5.services].sort(byId) });
    expect(encodeMetadata(decoded)).toBe(encoded);
    // Words 1-3 (tokens, requests) are what AntseedStats reads, in every version.
    const words = (hex: string) => hex.slice(2).match(/.{64}/g)!;
    expect(words(encoded).slice(1, 4)).toEqual(words(encodeMetadataV4(usageFixture)).slice(1, 4));
  });

  it('still decodes v4, with no speech characters', () => {
    const decoded = decodeSpendingAuthMetadata(encodeMetadataV4(usageFixture));
    expect(decoded.version).toBe(4n);
    expect(decoded.cumulativeInputCharacters).toBe(0n);
    expect(decoded.cumulativeVideoSeconds).toBe(8n);
    expect(decoded.services.map((service) => service.cumulativeInputCharacters)).toEqual([0n, 0n]);
    const video = decoded.services.find((service) => service.serviceId === usageFixture.services[1]!.serviceId);
    expect(video).toEqual({ ...usageFixture.services[1]!, cumulativeInputCharacters: 0n });
  });

  it('refuses versions it does not know', () => {
    const v3 = AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256', 'uint256', 'uint256'], [3n, 1n, 1n, 1n]);
    expect(() => decodeSpendingAuthMetadata(v3)).toThrow('Unsupported SpendingAuth metadata version 3');
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
