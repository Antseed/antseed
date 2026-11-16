/**
 * Provider type - using string for flexibility with custom providers.
 */
export type ProviderType = 'anthropic' | 'openai' | 'google' | 'moonshot' | string;

/**
 * Token count estimate derived from HTTP content-length.
 * NOT exact -- this is a heuristic estimate.
 */
export interface TokenCount {
  /** Estimated input tokens (from request content-length) */
  inputTokens: number;
  /** Estimated output tokens (from response content-length) */
  outputTokens: number;
  /** Total estimated tokens */
  totalTokens: number;
  /** The estimation method used */
  method: 'content-length' | 'chunk-accumulation' | 'provider-usage' | 'fallback';
  /**
   * Confidence level of the estimate.
   * 'high' = Content-Length header was present.
   * 'medium' = accumulated from stream chunks.
   * 'low' = fallback estimate based on request path / defaults.
   */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * A single metering event for one request/response cycle.
 */
export interface MeteringEvent {
  /** Unique event ID (UUIDv4) */
  eventId: string;
  /** Session this event belongs to */
  sessionId: string;
  /** Timestamp of the request (ms since epoch) */
  timestamp: number;
  /** Provider used */
  provider: ProviderType;
  /** Seller peer ID */
  sellerPeerId: string;
  /** Buyer peer ID */
  buyerPeerId: string;
  /** Token estimate */
  tokens: TokenCount;
  /** Request latency in ms (from send to first byte) */
  latencyMs: number;
  /** HTTP status code of the response */
  statusCode: number;
  /** Whether the response was streamed (SSE) */
  wasStreaming: boolean;
  /** Service (model id) the buyer asked for, when known. */
  service?: string;
  /** A short upstream error for a failed request (status 400 and above). */
  error?: string;
  /** Input tokens served from the upstream's prompt cache, when it reported them. */
  cachedInputTokens?: number;
  /** The protocol request id; a one-off payment channel records the same id. */
  requestId?: string;
}

/**
 * Signed usage receipt produced by the seller after each request.
 * The receipt is the unit of billing -- payments settle based on receipts.
 */
export interface UsageReceipt {
  /** Unique receipt ID (UUIDv4) */
  receiptId: string;
  /** Session ID this receipt belongs to */
  sessionId: string;
  /** Corresponding metering event ID */
  eventId: string;
  /** Timestamp of receipt creation (ms since epoch) */
  timestamp: number;
  /** Provider used */
  provider: ProviderType;
  /** Seller's peer ID */
  sellerPeerId: string;
  /** Buyer's peer ID */
  buyerPeerId: string;
  /** Seller's token estimate */
  tokens: TokenCount;
  /** Effective unit price in USD cents per 1,000 tokens (derived from seller offer pricing). */
  unitPriceCentsPerThousandTokens: number;
  /** Total cost in USD cents: (totalTokens / 1000) * unitPriceCentsPerThousandTokens */
  costCents: number;
  /**
   * secp256k1 signature over the receipt data (hex string).
   * Signs: receiptId + sessionId + eventId + timestamp + provider
   *        + sellerPeerId + buyerPeerId + totalTokens + costCents
   */
  signature: string;
}

/**
 * Result of buyer verifying a seller's receipt.
 */
export interface ReceiptVerification {
  /** The receipt being verified */
  receiptId: string;
  /** Whether the signature is valid */
  signatureValid: boolean;
  /** Buyer's independent token estimate */
  buyerTokenEstimate: TokenCount;
  /** Seller's token estimate (from receipt) */
  sellerTokenEstimate: TokenCount;
  /** Absolute difference in total tokens */
  tokenDifference: number;
  /**
   * Percentage difference: abs(seller - buyer) / max(seller, buyer) * 100
   */
  percentageDifference: number;
  /**
   * Whether the discrepancy exceeds the acceptable threshold.
   * Default threshold: 15%
   */
  disputed: boolean;
  /** Verification timestamp */
  verifiedAt: number;
}

/**
 * Aggregated metrics for a single session.
 */
export interface SessionMetrics {
  /** Session ID */
  sessionId: string;
  /** Seller's peer ID */
  sellerPeerId: string;
  /** Buyer's peer ID */
  buyerPeerId: string;
  /** Provider used */
  provider: ProviderType;
  /** Session start time */
  startedAt: number;
  /** Session end time (null if still active) */
  endedAt: number | null;
  /** Total requests in this session */
  totalRequests: number;
  /** Total estimated tokens */
  totalTokens: number;
  /** Total cost in USD cents (sum of receipt costs) */
  totalCostCents: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Number of peer switches during this session */
  peerSwitches: number;
  /** Number of disputed receipts */
  disputedReceipts: number;
}

/**
 * Aggregated usage over a time period.
 */
export interface UsageAggregate {
  /** Start of aggregation period */
  periodStart: number;
  /** End of aggregation period */
  periodEnd: number;
  /** Granularity of the period */
  granularity: 'daily' | 'weekly' | 'monthly';
  /** Total sessions in this period */
  totalSessions: number;
  /** Total requests */
  totalRequests: number;
  /** Total estimated tokens */
  totalTokens: number;
  /** Total cost/earnings in USD cents */
  totalCostCents: number;
  /** Breakdown by provider */
  byProvider: Record<ProviderType, {
    requests: number;
    tokens: number;
    costCents: number;
  }>;
  /** Breakdown by peer (top N) */
  topPeers: Array<{
    peerId: string;
    requests: number;
    tokens: number;
    costCents: number;
  }>;
}
