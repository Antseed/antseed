/**
 * Guards the shared-protocol wiring: @antseed/node must re-export the exact
 * same implementations the SDK uses from @antseed/protocol, and the SDK's
 * hello envelope must be accepted by the node-side verifier.
 */

import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import {
  verifyUtf8,
  encodeFrame as nodeEncodeFrame,
  FrameDecoder as NodeFrameDecoder,
  decodeSpendingAuth as nodeDecodeSpendingAuth,
} from '@antseed/node/p2p';
import { toPeerId, MessageType as NodeMessageType } from '@antseed/node';
import {
  computeChannelId as nodeComputeChannelId,
  computeMetadataHash as nodeComputeMetadataHash,
  signSpendingAuth as nodeSignSpendingAuth,
  ZERO_METADATA_HASH as NODE_ZERO_METADATA_HASH,
} from '@antseed/node/payments';
import {
  MessageType,
  FrameDecoder,
  encodeFrame,
  decodeSpendingAuth,
  computeChannelId,
  computeMetadataHash,
  signSpendingAuth,
  ZERO_METADATA_HASH,
  buildConnectionAuthPayload,
} from '@antseed/protocol';
import { buildHelloEnvelope } from './identity.js';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

describe('shared protocol wiring', () => {
  it('node re-exports the identical implementations', () => {
    expect(nodeEncodeFrame).toBe(encodeFrame);
    expect(NodeFrameDecoder).toBe(FrameDecoder);
    expect(nodeDecodeSpendingAuth).toBe(decodeSpendingAuth);
    expect(NodeMessageType).toBe(MessageType);
    expect(nodeComputeChannelId).toBe(computeChannelId);
    expect(nodeComputeMetadataHash).toBe(computeMetadataHash);
    expect(nodeSignSpendingAuth).toBe(signSpendingAuth);
    expect(NODE_ZERO_METADATA_HASH).toBe(ZERO_METADATA_HASH);
  });
});

describe('hello envelope', () => {
  it('is accepted by the node-side verifier', async () => {
    const envelope = await buildHelloEnvelope(wallet);
    expect(envelope.peerId).toBe(wallet.address.slice(2).toLowerCase());
    expect(envelope.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(envelope.sig).toMatch(/^[0-9a-f]{130}$/);
    const payload = buildConnectionAuthPayload('hello', envelope.peerId, envelope.ts, envelope.nonce);
    expect(verifyUtf8(toPeerId(envelope.peerId), payload, envelope.sig)).toBe(true);
  });
});
