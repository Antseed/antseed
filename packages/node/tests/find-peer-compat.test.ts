import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { GITHUB_VERIFICATION_PROOF_TYPE } from '../src/discovery/github-verification.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import * as publicJson from '../src/reputation/public-json.js';

function buildMetadata(peerId: string, timestamp = Date.now()): PeerMetadata {
  return {
    peerId: peerId as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 1,
      },
    ],
    region: 'test',
    timestamp,
    signature: 'b'.repeat(128),
  };
}

describe('AntseedNode.findPeer compatibility', () => {
  it('falls back to wildcard discovery for old sellers without per-peer topics', async () => {
    const targetId = 'a'.repeat(40);
    const otherId = 'b'.repeat(40);
    const node = new AntseedNode({ role: 'buyer' });

    (node as any)._peerLookup = {
      findByPeerId: vi.fn().mockResolvedValue([]),
      findAll: vi.fn().mockResolvedValue([
        {
          metadata: buildMetadata(otherId),
          host: '5.5.5.5',
          port: 6882,
        },
        {
          metadata: buildMetadata(targetId),
          host: '34.10.10.10',
          port: 6882,
        },
      ]),
    };

    const peer = await node.findPeer(targetId);

    expect(peer?.peerId).toBe(targetId);
    expect(peer?.publicAddress).toBe('34.10.10.10:6882');
    expect((node as any)._peerLookup.findByPeerId).toHaveBeenCalledWith(targetId);
    expect((node as any)._peerLookup.findAll).toHaveBeenCalledTimes(1);
  });

  it('does not scan wildcard when the per-peer topic returns a match', async () => {
    const targetId = 'a'.repeat(40);
    const node = new AntseedNode({ role: 'buyer' });

    (node as any)._peerLookup = {
      findByPeerId: vi.fn().mockResolvedValue([
        {
          metadata: buildMetadata(targetId),
          host: '34.10.10.10',
          port: 6882,
        },
      ]),
      findAll: vi.fn(),
    };

    const peer = await node.findPeer(targetId);

    expect(peer?.peerId).toBe(targetId);
    expect((node as any)._peerLookup.findAll).not.toHaveBeenCalled();
  });

  it('awaits identity verification before returning an explicitly requested peer', async () => {
    const targetId = 'a'.repeat(40);
    const node = new AntseedNode({ role: 'buyer' });
    const metadata = buildMetadata(targetId);
    metadata.verifications = { github: [{ username: 'octocat' }] };
    (node as any)._peerLookup = {
      findByPeerId: vi.fn().mockResolvedValue([{ metadata, host: '34.10.10.10', port: 6882 }]),
      findAll: vi.fn(),
    };
    (node as any)._identityHistoryCollector = { collect: vi.fn().mockResolvedValue({ version: 1, identities: [] }) };
    const proofFetch = vi.spyOn(publicJson, 'fetchPublicProof').mockResolvedValue(new Response(JSON.stringify({
      type: GITHUB_VERIFICATION_PROOF_TYPE,
      peerId: targetId,
      username: 'octocat',
    }), { status: 200 }));
    try {
      const peer = await node.findPeer(targetId, { awaitExternalVerification: true });

      expect(peer?.verificationResults?.verified).toBe(true);
      expect(peer?.verificationResults?.github[0]?.username).toBe('octocat');
    } finally {
      proofFetch.mockRestore();
    }
  });
});
