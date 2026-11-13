import { describe, it, expect } from 'vitest';
import {
  AntseedRequestError,
  buyerFault,
  peerFault,
  faultAttributionOf,
  faultCodeOf,
} from '../src/errors.js';
import { SellerAuthorizationError } from '../src/discovery/seller-address-resolver.js';
import { PeerConnection } from '../src/p2p/connection-manager.js';

describe('fault attribution', () => {
  it('defaults an untagged error to unknown, never to peer', () => {
    expect(faultAttributionOf(new Error('Request abc timed out'))).toBe('unknown');
    expect(faultAttributionOf('a string')).toBe('unknown');
    expect(faultAttributionOf(null)).toBe('unknown');
    expect(faultAttributionOf(undefined)).toBe('unknown');
  });

  it('reads the verdict off a tagged error', () => {
    expect(faultAttributionOf(buyerFault('nope', 'node-not-started'))).toBe('buyer');
    expect(faultAttributionOf(peerFault('nope', 'peer-protocol-violation'))).toBe('peer');
    expect(faultCodeOf(buyerFault('nope', 'buyer-deposits-insufficient')))
      .toBe('buyer-deposits-insufficient');
  });

  it('follows a cause chain so wrapping does not lose the verdict', () => {
    const wrapped = new Error('P2P request failed', {
      cause: buyerFault('no writable transport', 'buyer-transport-closed'),
    });
    expect(faultAttributionOf(wrapped)).toBe('buyer');
    expect(faultCodeOf(wrapped)).toBe('buyer-transport-closed');
  });

  it('survives a self-referential cause without looping', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(faultAttributionOf(err)).toBe('unknown');
  });

  it('ignores unrelated code fields such as ethers network errors', () => {
    const ethersLike = Object.assign(new Error('could not detect network'), {
      code: 'NETWORK_ERROR',
    });
    expect(faultCodeOf(ethersLike)).toBe(null);
    expect(faultAttributionOf(ethersLike)).toBe('unknown');
  });

  it('keeps the message and name of a tagged error intact', () => {
    const err = new AntseedRequestError('Node stopped', 'node-stopped', 'buyer');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Node stopped');
    expect(err.name).toBe('AntseedRequestError');
  });

  it('keeps a closed peer connection ambiguous so failover remains possible', () => {
    const connection = new PeerConnection({
      remotePeerId: 'a'.repeat(40),
      isInitiator: true,
    });

    let err: unknown;
    try {
      connection.send(new Uint8Array([1]));
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(Error);
    expect(faultAttributionOf(err)).toBe('unknown');
    expect(faultCodeOf(err)).toBe(null);
  });
});

describe('SellerAuthorizationError attribution', () => {
  it('blames the peer when the chain says it is not an operator', () => {
    const err = SellerAuthorizationError.peerNotAuthorized();
    expect(faultAttributionOf(err)).toBe('peer');
    expect(faultCodeOf(err)).toBe('peer-not-authorized');
  });

  it('blames the buyer when our own RPC could not answer', () => {
    const err = SellerAuthorizationError.rpcUnavailable();
    expect(faultAttributionOf(err)).toBe('buyer');
    expect(faultCodeOf(err)).toBe('chain-rpc-unavailable');
  });

  it('still reads as a SellerAuthorizationError to existing callers', () => {
    expect(SellerAuthorizationError.rpcUnavailable()).toBeInstanceOf(SellerAuthorizationError);
    expect(SellerAuthorizationError.peerNotAuthorized().message)
      .toBe('seller authorization failed: peer is not an authorized operator');
  });
});
