/**
 * Golden vectors pin the on-chain-facing encodings: a change to any of these
 * values breaks compatibility with deployed AntseedChannels contracts and
 * existing peers, so the constants below must never change.
 */

import { describe, it, expect } from 'vitest';
import { AbiCoder, Wallet, ZeroHash, keccak256, verifyTypedData } from 'ethers';
import {
  attributionTailAbi,
  clientAgentId,
  clientIdFromAgentId,
  decodeMetadataAttribution,
  encodeFreeUsageMetadata,
  encodeMetadata,
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
    expect(ZERO_METADATA_HASH).toBe('0xd26da485bf13b78f40dee0909067460d0d8d2510431238d75f7971400b85e0e3');
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
      '0xb9b176a3f2735a8160329e354c7ba2f0a84b39258c479b441702c3126210301c',
    );
    // Omitted cumulativeOutputImages encodes identically to an explicit zero.
    expect(computeMetadataHash({ ...metadata, cumulativeOutputImages: 0n })).toBe(
      computeMetadataHash(metadata),
    );
    expect(computeMetadataHash({ ...metadata, cumulativeOutputImages: 2n })).not.toBe(
      computeMetadataHash(metadata),
    );
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

describe('metadata attribution tail', () => {
  const clientId = clientIdFromAgentId(42);
  // Fixed vectors from packages/contracts (AntseedReferralsTest.test_inviteSignatureVector
  // and AntseedStatsV2Test.test_attributionTailVector).
  const invite = {
    epoch: 42n,
    index: 7n,
    r: '0xd802ee5a16750afbabae3b72ff1d3fd4b0e020078f532d083845ef4abd2c8eda',
    vs: '0x446c5c2a3057d6654b49e84d192c62a787ff15082d4748ae083e366b78e80755',
  };
  const METADATA_VECTOR_HASH = '0x60bd1b80e739efcf89d9cbd9a1c0e8fe9b562dbcbfb8434e12f799cb1d272d1e';
  const base = {
    cumulativeInputTokens: 100n,
    cumulativeOutputTokens: 40n,
    cumulativeRequestCount: 2n,
    cumulativeOutputImages: 1n,
    services: [{
      serviceId: '0x' + 'ab'.repeat(32),
      cumulativeAmount: 5n,
      cumulativeInputTokens: 100n,
      cumulativeCachedInputTokens: 10n,
      cumulativeOutputTokens: 40n,
      cumulativeRequestCount: 2n,
      cumulativeOutputImages: 1n,
    }],
  };

  it('matches the AntseedStatsV2 tail vector byte for byte', () => {
    // The contract vector uses a uint256[] services array ([5]); the tail
    // words that follow it are what this package encodes.
    const tail = attributionTailAbi({ clientId: clientIdFromAgentId(42), invite });
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256[]', ...tail.types],
      [3n, 1000n, 200n, 3n, 0n, [5n], ...tail.values],
    );
    expect((encoded.length - 2) / 2).toBe(13 * 32);
    expect(keccak256(encoded)).toBe(METADATA_VECTOR_HASH);
    expect(decodeMetadataAttribution(encoded)).toEqual({ clientId, invite });
  });

  it('is omitted when no attribution is set', () => {
    expect(encodeMetadata(base)).toBe(encodeMetadata({ ...base, attribution: {} }));
    expect(decodeMetadataAttribution(encodeMetadata(base))).toBeNull();
    expect(decodeMetadataAttribution(encodeFreeUsageMetadata(base))).toBeNull();
  });

  it('round-trips on SpendingAuth metadata without disturbing legacy decoders', () => {
    const encoded = encodeMetadata({ ...base, attribution: { clientId, invite } });
    expect(decodeMetadataAttribution(encoded)).toEqual({ clientId, invite });
    expect(clientAgentId(clientId)).toBe(42n);
    const coder = AbiCoder.defaultAbiCoder();
    const legacy = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], encoded);
    expect(legacy.map(String)).toEqual(['3', '100', '40', '2']);
    const v3 = coder.decode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256',
        'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeOutputImages)[]'],
      encoded,
    );
    expect(v3[5].length).toBe(1);
    expect(String(v3[5][0].cumulativeCachedInputTokens)).toBe('10');
  });

  it('keeps the client with zero invite words once bound', () => {
    const encoded = encodeMetadata({ ...base, attribution: { clientId } });
    expect(decodeMetadataAttribution(encoded)).toEqual({ clientId, invite: null });
  });

  it('round-trips on FreeUsage metadata with an invite and no client', () => {
    const encoded = encodeFreeUsageMetadata({ ...base, attribution: { invite } });
    expect(decodeMetadataAttribution(encoded)).toEqual({ clientId: ZeroHash, invite });
    const coder = AbiCoder.defaultAbiCoder();
    const legacy = coder.decode(
      ['uint256', 'uint256', 'uint256', 'uint256',
        'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount)[]'],
      encoded,
    );
    expect(legacy.map((v) => (Array.isArray(v) ? v.length : String(v)))).toEqual(['1', '100', '40', '2', 1]);
  });

  it('ignores the retired two-word referrer tail', () => {
    const coder = AbiCoder.defaultAbiCoder();
    const retired = coder.encode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256[]', 'address', 'bytes32'],
      [3n, 1n, 2n, 3n, 0n, [], '0x' + '11'.repeat(20), clientId],
    );
    expect(decodeMetadataAttribution(retired)).toBeNull();
  });
});
