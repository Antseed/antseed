import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { ConnectionState } from '../src/types/connection.js';
import {
  CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1,
  type SweepRequestPayload,
} from '../src/types/protocol.js';
import { toPeerId } from '../src/types/peer.js';

function makePayload(): SweepRequestPayload {
  return {
    version: 1,
    evmChainId: 31337,
    relayAddress: '0x' + '8a'.repeat(20),
    from: '0x' + '11'.repeat(20),
    amount: '5000000',
    validAfter: 0,
    validBefore: 2_000_000_000,
    nonce: '0x' + 'aa'.repeat(32),
    sig3009: '0x' + 'ab'.repeat(65),
  };
}

describe('AntseedNode sweep broadcast capabilities', () => {
  it('only sends sweep requests to connected peers that advertise sweep relaying', () => {
    const relayPeer = toPeerId('a'.repeat(40));
    const nonRelayPeer = toPeerId('b'.repeat(40));
    const node = new AntseedNode({ role: 'buyer' });
    const sendSweepRequest = vi.fn();

    const connections = new Map([
      [relayPeer, { state: ConnectionState.Open }],
      [nonRelayPeer, { state: ConnectionState.Open }],
    ]);

    (node as unknown as {
      _connectionManager: { getConnection: (peerId: string) => { state: ConnectionState } | undefined };
      _muxes: Map<string, unknown>;
      _peerCapabilities: Map<string, Set<string>>;
      _getOrCreateSweepMux: () => { sendSweepRequest: typeof sendSweepRequest };
    })._connectionManager = {
      getConnection: (peerId: string) => connections.get(peerId),
    };
    (node as unknown as { _muxes: Map<string, unknown> })._muxes = new Map([
      [relayPeer, {}],
      [nonRelayPeer, {}],
    ]);
    (node as unknown as { _peerCapabilities: Map<string, Set<string>> })._peerCapabilities = new Map([
      [relayPeer, new Set([CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1])],
      [nonRelayPeer, new Set()],
    ]);
    (node as unknown as {
      _getOrCreateSweepMux: () => { sendSweepRequest: typeof sendSweepRequest };
    })._getOrCreateSweepMux = () => ({ sendSweepRequest });

    expect(node.broadcastSweepRequest(makePayload())).toBe(1);
    expect(sendSweepRequest).toHaveBeenCalledTimes(1);
  });
});

type NodeInternals = {
  _connectionManager: { getConnection: (peerId: string) => { state: ConnectionState } | undefined };
  _muxes: Map<string, unknown>;
  _peerCapabilities: Map<string, Set<string>>;
  _getOrCreateSweepMux: (peerId: string) => { sendSweepRequest: (payload: SweepRequestPayload) => void };
};

/** Wire up a buyer node with mocked relayer peers. `behavior` maps peerId to
 *  what the peer does when offered a sweep: a receipt status (sent async),
 *  or 'silent' to never respond. Returns the per-peer offer log. */
function makeDispatchNode(
  peers: Array<{ peerId: string; behavior: 'submitted' | 'confirmed' | 'rejected' | 'silent'; capable?: boolean }>,
): { node: AntseedNode; offers: string[] } {
  const node = new AntseedNode({ role: 'buyer' });
  const offers: string[] = [];
  const internals = node as unknown as NodeInternals;

  internals._connectionManager = {
    getConnection: () => ({ state: ConnectionState.Open }),
  };
  internals._muxes = new Map(peers.map((p) => [p.peerId, {}]));
  internals._peerCapabilities = new Map(peers.map((p) => [
    p.peerId,
    new Set(p.capable === false ? [] : [CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1]),
  ]));
  internals._getOrCreateSweepMux = (peerId: string) => ({
    sendSweepRequest: (payload: SweepRequestPayload) => {
      offers.push(peerId);
      const behavior = peers.find((p) => p.peerId === peerId)?.behavior;
      if (behavior === 'silent' || behavior === undefined) return;
      setTimeout(() => {
        node.emit('sweep:receipt', {
          peerId,
          payload: { version: 1, authNonce: payload.nonce, status: behavior },
        });
      }, 5);
    },
  });
  return { node, offers };
}

describe('AntseedNode sequential sweep dispatch', () => {
  it('stops offering once a relayer reports submitted', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // keep candidate order stable
    const a = toPeerId('a'.repeat(40));
    const b = toPeerId('b'.repeat(40));
    const { node, offers } = makeDispatchNode([
      { peerId: a, behavior: 'submitted' },
      { peerId: b, behavior: 'submitted' },
    ]);

    const result = await node.dispatchSweepRequest(makePayload(), { perPeerTimeoutMs: 200 });
    expect(result).toEqual({ offered: 1, accepted: true });
    expect(offers).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('passes the offer to the next relayer on rejection', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const a = toPeerId('a'.repeat(40));
    const b = toPeerId('b'.repeat(40));
    const { node, offers } = makeDispatchNode([
      { peerId: a, behavior: 'rejected' },
      { peerId: b, behavior: 'confirmed' },
    ]);

    const result = await node.dispatchSweepRequest(makePayload(), { perPeerTimeoutMs: 200 });
    expect(result).toEqual({ offered: 2, accepted: true });
    expect(offers).toEqual([a, b]);
    vi.restoreAllMocks();
  });

  it('moves on after a silent relayer times out', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const a = toPeerId('a'.repeat(40));
    const b = toPeerId('b'.repeat(40));
    const { node, offers } = makeDispatchNode([
      { peerId: a, behavior: 'silent' },
      { peerId: b, behavior: 'submitted' },
    ]);

    const result = await node.dispatchSweepRequest(makePayload(), { perPeerTimeoutMs: 50 });
    expect(result).toEqual({ offered: 2, accepted: true });
    expect(offers).toEqual([a, b]);
    vi.restoreAllMocks();
  });

  it('offers sweeps last to a relayer that accepted one and then failed to submit it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const a = toPeerId('a'.repeat(40));
    const b = toPeerId('b'.repeat(40));
    const { node, offers } = makeDispatchNode([
      { peerId: a, behavior: 'submitted' },
      { peerId: b, behavior: 'submitted' },
    ]);

    const first = makePayload();
    expect(await node.dispatchSweepRequest(first, { perPeerTimeoutMs: 200 })).toEqual({ offered: 1, accepted: true });
    node.emit('sweep:receipt', { peerId: a, payload: { version: 1, authNonce: first.nonce, status: 'rejected', reason: 'submission failed' } });

    const second = { ...makePayload(), nonce: '0x' + 'bb'.repeat(32) };
    expect(await node.dispatchSweepRequest(second, { perPeerTimeoutMs: 200 })).toEqual({ offered: 1, accepted: true });
    expect(offers).toEqual([a, b]);
    vi.restoreAllMocks();
  });

  it('reports no acceptance when every relayer declines', async () => {
    const a = toPeerId('a'.repeat(40));
    const b = toPeerId('b'.repeat(40));
    const { node } = makeDispatchNode([
      { peerId: a, behavior: 'rejected' },
      { peerId: b, behavior: 'rejected' },
    ]);

    const result = await node.dispatchSweepRequest(makePayload(), { perPeerTimeoutMs: 200 });
    expect(result).toEqual({ offered: 2, accepted: false });
  });

  it('never offers to peers without the relay capability', async () => {
    const a = toPeerId('a'.repeat(40));
    const b = toPeerId('b'.repeat(40));
    const { node, offers } = makeDispatchNode([
      { peerId: a, behavior: 'rejected', capable: false },
      { peerId: b, behavior: 'submitted' },
    ]);

    const result = await node.dispatchSweepRequest(makePayload(), { perPeerTimeoutMs: 200 });
    expect(result).toEqual({ offered: 1, accepted: true });
    expect(offers).toEqual([b]);
  });

  it('does not offer an authorization that is about to expire', async () => {
    const a = toPeerId('a'.repeat(40));
    const { node, offers } = makeDispatchNode([{ peerId: a, behavior: 'submitted' }]);

    const payload = { ...makePayload(), validBefore: Math.floor(Date.now() / 1000) + 5 };
    const result = await node.dispatchSweepRequest(payload, { perPeerTimeoutMs: 200 });
    expect(result).toEqual({ offered: 0, accepted: false });
    expect(offers).toHaveLength(0);
  });
});
