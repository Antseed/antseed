import { describe, expect, it } from 'vitest';
import { AntseedNode, type ResponseAuthEvent } from '../src/node.js';

const RECEIPT = {
  version: 1 as const,
  requestId: 'req-1',
  buyerPeerId: '4'.repeat(40),
  sellerPeerId: '6'.repeat(40),
  advertisedService: 'claimed-model',
  provider: 'p',
  statusCode: 200,
  requestHash: 'a'.repeat(64),
  responseHash: 'b'.repeat(64),
  responseStartedAt: 1,
  responseCompletedAt: 2,
  signature: '00',
  receivedAt: 3,
  verified: false,
  verificationError: 'response_hash_mismatch',
};

function sinkOf(node: AntseedNode) {
  return (node as unknown as { _responseAuthSink: { insertResponseAuth: (record: typeof RECEIPT, context?: { sellerPeerId: string; requestedService: string }) => void } })._responseAuthSink;
}

describe('response-auth event', () => {
  it('names the peer and service of the request, not those the receipt claims', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const events: ResponseAuthEvent[] = [];
    node.on('response-auth', (event: ResponseAuthEvent) => events.push(event));

    sinkOf(node).insertResponseAuth(RECEIPT, { sellerPeerId: '5'.repeat(40), requestedService: 'requested-model' });

    expect(events).toEqual([{
      requestId: 'req-1',
      sellerPeerId: '5'.repeat(40),
      advertisedService: 'requested-model',
      verified: false,
      verificationError: 'response_hash_mismatch',
    }]);
  });

  it('reports nothing for a receipt without request context', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const events: ResponseAuthEvent[] = [];
    node.on('response-auth', (event: ResponseAuthEvent) => events.push(event));

    sinkOf(node).insertResponseAuth(RECEIPT);

    expect(events).toEqual([]);
  });
});
