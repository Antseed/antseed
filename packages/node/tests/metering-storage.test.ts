import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MeteringStorage } from '../src/metering/storage.js';
import type {
  MeteringEvent,
  UsageReceipt,
  ReceiptVerification,
  SessionMetrics,
  TokenCount,
} from '../src/types/metering.js';

let storage: MeteringStorage;

function makeTokens(total: number): TokenCount {
  return {
    inputTokens: Math.floor(total * 0.6),
    outputTokens: Math.ceil(total * 0.4),
    totalTokens: total,
    method: 'content-length',
    confidence: 'high',
  };
}

function makeEvent(overrides?: Partial<MeteringEvent>): MeteringEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    provider: 'openai',
    sellerPeerId: 'seller-1',
    buyerPeerId: 'buyer-1',
    tokens: makeTokens(1000),
    latencyMs: 150,
    statusCode: 200,
    wasStreaming: false,
    ...overrides,
  };
}

function makeReceipt(overrides?: Partial<UsageReceipt>): UsageReceipt {
  return {
    receiptId: `rcpt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-1',
    eventId: 'evt-1',
    timestamp: Date.now(),
    provider: 'openai',
    sellerPeerId: 'seller-1',
    buyerPeerId: 'buyer-1',
    tokens: makeTokens(1000),
    unitPriceCentsPerThousandTokens: 10,
    costCents: 10,
    signature: 'a'.repeat(128),
    ...overrides,
  };
}

function makeVerification(overrides?: Partial<ReceiptVerification>): ReceiptVerification {
  return {
    receiptId: `rcpt-${Math.random().toString(36).slice(2)}`,
    signatureValid: true,
    buyerTokenEstimate: makeTokens(1000),
    sellerTokenEstimate: makeTokens(1050),
    tokenDifference: 50,
    percentageDifference: 4.76,
    disputed: false,
    verifiedAt: Date.now(),
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionMetrics>): SessionMetrics {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2)}`,
    sellerPeerId: 'seller-1',
    buyerPeerId: 'buyer-1',
    provider: 'openai',
    startedAt: Date.now(),
    endedAt: null,
    totalRequests: 5,
    totalTokens: 5000,
    totalCostCents: 50,
    avgLatencyMs: 200,
    peerSwitches: 0,
    disputedReceipts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  storage = new MeteringStorage(':memory:');
});

afterEach(() => {
  storage.close();
});

describe('MeteringStorage — Events', () => {
  it('should insert and retrieve events by session', () => {
    const event = makeEvent({ sessionId: 'sess-a' });
    storage.insertEvent(event);

    const events = storage.getEventsBySession('sess-a');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe(event.eventId);
    expect(events[0]!.tokens.totalTokens).toBe(1000);
    expect(events[0]!.wasStreaming).toBe(false);
  });

  it('should retrieve events by time range', () => {
    const now = Date.now();
    storage.insertEvent(makeEvent({ eventId: 'e1', timestamp: now - 2000 }));
    storage.insertEvent(makeEvent({ eventId: 'e2', timestamp: now - 500 }));
    storage.insertEvent(makeEvent({ eventId: 'e3', timestamp: now + 1000 }));

    const events = storage.getEventsByTimeRange(now - 3000, now);
    expect(events).toHaveLength(2);
  });

  it('should return empty for non-existent session', () => {
    expect(storage.getEventsBySession('nonexistent')).toEqual([]);
  });
});

describe('MeteringStorage — Receipts', () => {
  it('should insert and retrieve receipts by session', () => {
    const receipt = makeReceipt({ sessionId: 'sess-b' });
    storage.insertReceipt(receipt);

    const receipts = storage.getReceiptsBySession('sess-b');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.costCents).toBe(10);
    expect(receipts[0]!.signature).toBe('a'.repeat(128));
  });

  it('should calculate total cost in a time range', () => {
    const now = Date.now();
    storage.insertReceipt(makeReceipt({ receiptId: 'r1', timestamp: now - 500, costCents: 10 }));
    storage.insertReceipt(makeReceipt({ receiptId: 'r2', timestamp: now - 200, costCents: 20 }));
    storage.insertReceipt(makeReceipt({ receiptId: 'r3', timestamp: now + 1000, costCents: 100 }));

    const total = storage.getTotalCost(now - 1000, now);
    expect(total).toBe(30);
  });

  it('should return 0 total cost for empty range', () => {
    expect(storage.getTotalCost(0, 1)).toBe(0);
  });
});

describe('MeteringStorage — Verifications', () => {
  it('should insert and retrieve disputed verifications', () => {
    const now = Date.now();
    storage.insertVerification(
      makeVerification({ receiptId: 'v1', disputed: true, verifiedAt: now - 100 })
    );
    storage.insertVerification(
      makeVerification({ receiptId: 'v2', disputed: false, verifiedAt: now - 50 })
    );

    const disputed = storage.getDisputedVerifications(now - 200, now + 200);
    expect(disputed).toHaveLength(1);
    expect(disputed[0]!.receiptId).toBe('v1');
    expect(disputed[0]!.disputed).toBe(true);
  });
});

describe('MeteringStorage — Sessions', () => {
  it('should upsert and retrieve a session', () => {
    const session = makeSession({ sessionId: 'sess-x' });
    storage.upsertSession(session);

    const retrieved = storage.getSession('sess-x');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.totalRequests).toBe(5);
    expect(retrieved!.endedAt).toBeNull();
  });

  it('should update session on upsert with same ID', () => {
    const session = makeSession({ sessionId: 'sess-y', totalRequests: 1 });
    storage.upsertSession(session);

    session.totalRequests = 10;
    session.endedAt = Date.now();
    storage.upsertSession(session);

    const retrieved = storage.getSession('sess-y');
    expect(retrieved!.totalRequests).toBe(10);
    expect(retrieved!.endedAt).not.toBeNull();
  });

  it('should return null for non-existent session', () => {
    expect(storage.getSession('nonexistent')).toBeNull();
  });

  it('should get session summary for a time range', () => {
    const now = Date.now();
    storage.upsertSession(makeSession({ sessionId: 's1', startedAt: now - 500, totalCostCents: 10, totalTokens: 1000, totalRequests: 5 }));
    storage.upsertSession(makeSession({ sessionId: 's2', startedAt: now - 200, totalCostCents: 20, totalTokens: 2000, totalRequests: 3 }));

    const summary = storage.getSessionSummary(now - 1000, now);
    expect(summary.channelCount).toBe(2);
    expect(summary.totalCostCents).toBe(30);
    expect(summary.totalTokens).toBe(3000);
    expect(summary.totalRequests).toBe(8);
  });

  it('should get event token summary', () => {
    const now = Date.now();
    storage.insertEvent(makeEvent({ eventId: 'e1', timestamp: now - 500, tokens: makeTokens(1000) }));
    storage.insertEvent(makeEvent({ eventId: 'e2', timestamp: now - 200, tokens: makeTokens(2000) }));

    const summary = storage.getEventTokenSummary(now - 1000, now);
    expect(summary.totalRequests).toBe(2);
    expect(summary.totalTokens).toBe(3000);
  });
  it('should get event stats by peer', () => {
    const now = Date.now();
    storage.insertEvent(makeEvent({ eventId: 'e1', timestamp: now - 500, sellerPeerId: 'seller-A', tokens: makeTokens(1000) }));
    storage.insertEvent(makeEvent({ eventId: 'e2', timestamp: now - 200, sellerPeerId: 'seller-A', tokens: makeTokens(2000) }));
    storage.insertEvent(makeEvent({ eventId: 'e3', timestamp: now - 100, sellerPeerId: 'seller-B', tokens: makeTokens(500) }));
    storage.upsertSession(makeSession({ sessionId: 's1', sellerPeerId: 'seller-A', totalCostCents: 30 }));

    const statsA = storage.getEventStatsByPeer('seller-A');
    expect(statsA.totalRequests).toBe(2);
    expect(statsA.totalTokens).toBe(3000);
    expect(statsA.inputTokens).toBe(makeTokens(1000).inputTokens + makeTokens(2000).inputTokens);
    expect(statsA.outputTokens).toBe(makeTokens(1000).outputTokens + makeTokens(2000).outputTokens);
    expect(statsA.totalCostCents).toBe(30);
    expect(statsA.firstEventAt).toBe(now - 500);
    expect(statsA.lastEventAt).toBe(now - 200);

    const statsB = storage.getEventStatsByPeer('seller-B');
    expect(statsB.totalRequests).toBe(1);
    expect(statsB.totalTokens).toBe(500);
    expect(statsB.totalCostCents).toBe(0);

    const statsNone = storage.getEventStatsByPeer('nonexistent');
    expect(statsNone.totalRequests).toBe(0);
    expect(statsNone.totalTokens).toBe(0);
  });
});

describe('MeteringStorage — Pruning', () => {
  it('should delete data older than given timestamp', () => {
    const now = Date.now();
    const old = now - 100000;
    const recent = now - 100;

    storage.insertEvent(makeEvent({ eventId: 'old-e', timestamp: old }));
    storage.insertEvent(makeEvent({ eventId: 'new-e', timestamp: recent }));
    storage.insertReceipt(makeReceipt({ receiptId: 'old-r', timestamp: old }));
    storage.insertReceipt(makeReceipt({ receiptId: 'new-r', timestamp: recent }));
    storage.insertVerification(makeVerification({ receiptId: 'old-v', verifiedAt: old, disputed: true }));
    storage.insertVerification(makeVerification({ receiptId: 'new-v', verifiedAt: recent, disputed: true }));
    storage.upsertSession(makeSession({ sessionId: 'old-s', startedAt: old }));
    storage.upsertSession(makeSession({ sessionId: 'new-s', startedAt: recent }));
    storage.consumeFreeTierRequest({ buyerAddress: '0x1', remoteIp: null, service: 'free', maxRequestsPerAddress: 10, maxRequestsPerIp: null, windowMs: 200000, nowMs: old });
    storage.consumeFreeTierRequest({ buyerAddress: '0x1', remoteIp: null, service: 'free', maxRequestsPerAddress: 10, maxRequestsPerIp: null, windowMs: 200000, nowMs: recent });

    const cutoff = now - 50000;
    const result = storage.pruneOlderThan(cutoff);

    expect(result.eventsDeleted).toBe(1);
    expect(result.receiptsDeleted).toBe(1);
    expect(result.verificationsDeleted).toBe(1);
    expect(result.sessionsDeleted).toBe(1);
    expect(result.freeTierUsageDeleted).toBe(1);

    // Recent data should still exist
    expect(storage.getEventsByTimeRange(recent - 10, recent + 10)).toHaveLength(1);
    expect(storage.getReceiptsByTimeRange(recent - 10, recent + 10)).toHaveLength(1);
  });
});
