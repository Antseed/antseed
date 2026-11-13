# 03 - Metering Protocol

This document specifies the metering protocol: how token usage is estimated, receipts are generated and verified, sessions are tracked, and usage data is stored and aggregated.

Source modules (all in `@antseed/node`):
- `src/metering/token-counter.ts`
- `src/types/metering.ts`
- `src/metering/receipt-generator.ts`
- `src/metering/receipt-verifier.ts`
- `src/metering/session-tracker.ts`
- `src/metering/storage.ts`
- `src/metering/usage-aggregator.ts`

---

## Token Estimation

Token counts are estimated from HTTP content lengths and stream byte totals. These are heuristic estimates, not exact counts.

### Provider-Specific Bytes-Per-Token Ratios

| Provider    | Bytes per Token | Notes                                    |
|-------------|-----------------|------------------------------------------|
| `anthropic` | 4.2             | Claude tokenizer, JSON Messages API      |
| `openai`    | 4.0             | tiktoken cl100k_base, JSON Chat API      |
| `google`    | 4.1             | Gemini tokenizer, JSON generateContent API |
| `moonshot`  | 4.0             | Similar to OpenAI tokenizer              |
| `default`   | 4.0             | Fallback for unknown providers           |

Ratios are empirical averages. English text averages approximately 4 bytes per token across most tokenizers. JSON overhead (keys, brackets, quotes), system prompts, and tool definitions increase the effective ratio.

### Stream Overhead Factor

When estimating tokens from SSE stream bytes, a factor of **0.82** is applied to account for SSE framing overhead (approximately 18% of stream bytes are `data:` prefixes, newlines, and event framing, not content):

```
contentBytes = totalBytes * 0.82
tokens = ceil(contentBytes / bytesPerToken)
```

### Minimum Thresholds

| Direction | Minimum Tokens | Rationale                                        |
|-----------|---------------|--------------------------------------------------|
| Request   | 100           | LLM API requests always include at least a system prompt |
| Response  | 10            | Even error responses contain some tokens         |

Minimums are applied when Content-Length is missing, zero, or when the calculated estimate falls below the threshold.

### Estimation Methods

| Method               | Used When                                           | Confidence |
|----------------------|-----------------------------------------------------|------------|
| `content-length`     | Response Content-Length header is present and > 0    | `high`     |
| `chunk-accumulation` | Response is SSE streaming with accumulated byte total | `medium`   |
| `fallback`           | Neither content-length nor stream bytes available    | `low`      |

Input tokens are always estimated from the request Content-Length header using the `content-length` method. Output token method varies by response type.

### Estimation Functions

- `estimateTokensFromContentLength(contentLength, provider, direction)` -- Divides content length by the provider's bytes-per-token ratio, applies `Math.ceil`, and enforces the minimum threshold for the given direction.
- `estimateTokensFromStreamBytes(totalBytes, provider)` -- Multiplies total bytes by 0.82 (stream overhead factor), divides by the provider ratio, applies `Math.ceil`, and enforces the response minimum threshold.
- `estimateTokens(requestContentLength, responseContentLength, provider, isStreaming, streamTotalBytes?)` -- Orchestrates the above functions and returns a complete `TokenCount`.

---

## Metering Events

A `MeteringEvent` represents one request/response cycle through the proxy.

### MeteringEvent Interface

| Field           | Type          | Description                                  |
|-----------------|---------------|----------------------------------------------|
| `eventId`       | `string`      | Unique event ID (UUIDv4)                     |
| `sessionId`     | `string`      | Session this event belongs to                |
| `timestamp`     | `number`      | Timestamp of the request (ms since epoch)    |
| `provider`      | `ProviderType` | Provider used (`anthropic`, `openai`, `google`, `moonshot`, or custom string) |
| `sellerPeerId`  | `string`      | Seller peer ID                               |
| `buyerPeerId`   | `string`      | Buyer peer ID                                |
| `tokens`        | `TokenCount`  | Token estimate for this request              |
| `latencyMs`     | `number`      | Request latency in ms (send to first byte)   |
| `statusCode`    | `number`      | HTTP status code of the response             |
| `wasStreaming`   | `boolean`     | Whether the response was streamed (SSE)      |

### TokenCount Interface

| Field          | Type                                               | Description                       |
|----------------|-----------------------------------------------------|-----------------------------------|
| `inputTokens`  | `number`                                            | Estimated input tokens (from request content-length) |
| `outputTokens` | `number`                                            | Estimated output tokens (from response content-length or stream) |
| `totalTokens`  | `number`                                            | `inputTokens + outputTokens`      |
| `method`       | `'content-length' \| 'chunk-accumulation' \| 'fallback'` | Estimation method used       |
| `confidence`   | `'high' \| 'medium' \| 'low'`                      | Confidence level of the estimate  |

---

## Usage Receipts

Receipts are the unit of billing. The seller generates a signed receipt after each request; payments settle based on receipts.

### Non-Token Unit Usage

Protocols may define canonical non-token usage alongside token counts. Metadata v11 introduces `UnitBillingModelV1`; the initial supported unit is `output_images` for the `openai-images` API protocol.

For image responses, both peers count non-empty `b64_json` or `url` outputs. The seller's advertised component model maps the observed count and request attributes (`model`, `size`, `quality`, or `resolution`) to a USD amount. Positive delivered usage must match at least one component. Unmatched usage is an error, not a zero-price result.

Token and unit costs are computed independently and then summed. The buyer verifies both portions before authorizing cumulative payment.

### UsageReceipt Interface

| Field            | Type          | Description                                    |
|------------------|---------------|------------------------------------------------|
| `receiptId`      | `string`      | Unique receipt ID (UUIDv4)                     |
| `sessionId`      | `string`      | Session ID this receipt belongs to             |
| `eventId`        | `string`      | Corresponding metering event ID                |
| `timestamp`      | `number`      | Timestamp of receipt creation (ms since epoch) |
| `provider`       | `ProviderType` | Provider used                                 |
| `sellerPeerId`   | `string`      | Seller's peer ID                               |
| `buyerPeerId`    | `string`      | Buyer's peer ID                                |
| `tokens`         | `TokenCount`  | Seller's token estimate                        |
| `unitPriceCentsPerThousandTokens` | `number`      | Effective unit price in USD cents per 1,000 tokens |
| `costCents`      | `number`      | Total cost in USD cents                        |
| `signature`      | `string`      | secp256k1 signature over receipt data (hex string) |

### Signature Payload Format

The `buildSignaturePayload()` function creates a deterministic string by joining receipt fields with `|` (pipe) delimiter:

```
receiptId | sessionId | eventId | timestamp | provider | sellerPeerId | buyerPeerId | totalTokens | costCents
```

All numeric fields are converted to strings via `.toString()`. The resulting string is signed with the seller's secp256k1 private key (via EIP-191 personal_sign).

### Cost Calculation

```typescript
// Seller offer pricing is configured in USD per 1M tokens.
// cachedInputUsdPerMillion defaults to inputUsdPerMillion when not set.
const effectiveCachedPrice = cachedInputUsdPerMillion ?? inputUsdPerMillion;
const estimatedCostUsd =
  (freshInputTokens * inputUsdPerMillion + cachedInputTokens * effectiveCachedPrice + outputTokens * outputUsdPerMillion) / 1_000_000;

// Receipts normalize this to cents per 1,000 tokens for compact transport/storage.
const unitPriceCentsPerThousandTokens =
  totalTokens > 0 ? (estimatedCostUsd / totalTokens) * 1000 * 100 : 0;

const raw = (totalTokens / 1000) * unitPriceCentsPerThousandTokens;
const costCents = raw > 0 ? Math.max(1, Math.round(raw)) : 0;
```

- Cost is in USD cents
- Non-zero usage always costs at least 1 cent (`Math.max(1, ...)`)
- Zero tokens result in zero cost
- Rounding uses `Math.round` (not `Math.ceil`)

### Receipt Generation

The `ReceiptGenerator` class requires a `Signer` interface:

```typescript
interface Signer {
  sign(message: string): string;  // Returns hex-encoded secp256k1 signature
  peerId: string;                 // Seller's peer ID (EVM address hex)
}
```

The `generate()` method:
1. Creates a UUIDv4 `receiptId`
2. Records `timestamp` as `Date.now()`
3. Calculates `costCents` using the cost formula above
4. Builds the signature payload from all receipt fields
5. Signs the payload with the seller's secp256k1 private key
6. Returns the complete `UsageReceipt` with signature

---

## Receipt Verification

The buyer verifies each seller-issued receipt independently.

### Verification Steps

1. **Verify secp256k1 signature** -- Reconstruct the signature payload using `buildSignaturePayload()` and verify via ecrecover against the seller's address (their `sellerPeerId`)
2. **Compare token estimates** -- Compare the seller's `totalTokens` with the buyer's independent `totalTokens` estimate
3. **Calculate percentage difference** -- `abs(sellerTotal - buyerTotal) / max(sellerTotal, buyerTotal) * 100` (returns 0 if both are 0)
4. **Flag as disputed** -- Disputed if signature is invalid OR percentage difference exceeds the threshold

### Dispute Threshold

Default: **15%** difference between buyer and seller token estimates triggers a dispute flag. Configurable via `VerifierOptions.disputeThresholdPercent`.

A receipt is also flagged as disputed if the secp256k1 signature verification fails, regardless of token difference.

### ReceiptVerification Interface

| Field                  | Type          | Description                                         |
|------------------------|---------------|-----------------------------------------------------|
| `receiptId`            | `string`      | The receipt being verified                          |
| `signatureValid`       | `boolean`     | Whether the secp256k1 signature is valid            |
| `buyerTokenEstimate`   | `TokenCount`  | Buyer's independent token estimate                  |
| `sellerTokenEstimate`  | `TokenCount`  | Seller's token estimate (from receipt)              |
| `tokenDifference`      | `number`      | Absolute difference in total tokens                 |
| `percentageDifference` | `number`      | `abs(seller - buyer) / max(seller, buyer) * 100`    |
| `disputed`             | `boolean`     | `!signatureValid \|\| percentageDifference > threshold` |
| `verifiedAt`           | `number`      | Verification timestamp (ms since epoch)             |

### SignatureVerifier Interface

```typescript
interface SignatureVerifier {
  verify(message: string, signature: string, publicKeyHex: string): boolean;
}
```

---

## Session Tracking

The `SessionTracker` extends `EventEmitter` and tracks metering events and receipts for a single session, computing running aggregates.

### Events Emitted

| Event              | Arguments                                          | Description                       |
|--------------------|----------------------------------------------------|-----------------------------------|
| `event-recorded`   | `(event: MeteringEvent)`                           | A metering event was recorded     |
| `receipt-recorded` | `(receipt: UsageReceipt, verification: ReceiptVerification)` | A receipt and its verification were recorded |
| `dispute-detected` | `(receiptId: string, percentageDifference: number)` | A receipt was flagged as disputed |
| `session-ended`    | `(metrics: SessionMetrics)`                        | The session has ended             |

### SessionMetrics Interface

| Field              | Type             | Description                                  |
|--------------------|------------------|----------------------------------------------|
| `sessionId`        | `string`         | Session ID                                   |
| `sellerPeerId`     | `string`         | Seller's peer ID                             |
| `buyerPeerId`      | `string`         | Buyer's peer ID                              |
| `provider`         | `ProviderType`   | Provider used                                |
| `startedAt`        | `number`         | Session start time (ms since epoch)          |
| `endedAt`          | `number \| null` | Session end time (null if still active)      |
| `totalRequests`    | `number`         | Total requests in this session               |
| `totalTokens`      | `number`         | Total estimated tokens                       |
| `totalCostCents`   | `number`         | Total cost in USD cents (sum of receipt costs) |
| `avgLatencyMs`     | `number`         | Average latency in ms (`totalLatencyMs / totalRequests`, 0 if no requests) |
| `peerSwitches`     | `number`         | Number of peer switches during this session  |
| `disputedReceipts` | `number`         | Number of disputed receipts                  |

### Session Lifecycle

1. `constructor(sessionId, sellerPeerId, buyerPeerId, provider)` -- Initializes the session with `startedAt = Date.now()` and zeroed counters
2. `recordEvent(event)` -- Accumulates `totalTokens` and `totalLatencyMs`, emits `event-recorded`
3. `recordReceipt(receipt, verification)` -- Accumulates `totalCostCents`, increments `disputedCount` if verification is disputed (emitting `dispute-detected`), emits `receipt-recorded`
4. `recordPeerSwitch(newPeerId)` -- Increments `peerSwitches` if the new peer differs from the last tracked peer
5. `endSession()` -- Sets `endedAt = Date.now()`, emits `session-ended` with final `SessionMetrics`

---

## Storage

Metering data is persisted in a local SQLite database using `better-sqlite3`.

### Configuration

- **Journal mode**: WAL (Write-Ahead Logging) -- set via `PRAGMA journal_mode = WAL`
- **Database path**: Configurable, supports `:memory:` for tests

### Schema

#### Table: `metering_events`

| Column             | Type    | Constraint  |
|--------------------|---------|-------------|
| `event_id`         | TEXT    | PRIMARY KEY |
| `session_id`       | TEXT    | NOT NULL    |
| `timestamp`        | INTEGER | NOT NULL    |
| `provider`         | TEXT    | NOT NULL    |
| `seller_peer_id`   | TEXT    | NOT NULL    |
| `buyer_peer_id`    | TEXT    | NOT NULL    |
| `input_tokens`     | INTEGER | NOT NULL    |
| `output_tokens`    | INTEGER | NOT NULL    |
| `total_tokens`     | INTEGER | NOT NULL    |
| `token_method`     | TEXT    | NOT NULL    |
| `token_confidence` | TEXT    | NOT NULL    |
| `latency_ms`       | INTEGER | NOT NULL    |
| `status_code`      | INTEGER | NOT NULL    |
| `was_streaming`    | INTEGER | NOT NULL    |

Indices:
- `idx_events_session` on `session_id`
- `idx_events_timestamp` on `timestamp`

#### Table: `usage_receipts`

| Column             | Type    | Constraint  |
|--------------------|---------|-------------|
| `receipt_id`       | TEXT    | PRIMARY KEY |
| `session_id`       | TEXT    | NOT NULL    |
| `event_id`         | TEXT    | NOT NULL    |
| `timestamp`        | INTEGER | NOT NULL    |
| `provider`         | TEXT    | NOT NULL    |
| `seller_peer_id`   | TEXT    | NOT NULL    |
| `buyer_peer_id`    | TEXT    | NOT NULL    |
| `input_tokens`     | INTEGER | NOT NULL    |
| `output_tokens`    | INTEGER | NOT NULL    |
| `total_tokens`     | INTEGER | NOT NULL    |
| `token_method`     | TEXT    | NOT NULL    |
| `token_confidence` | TEXT    | NOT NULL    |
| `price_per_k_token`| INTEGER | NOT NULL    |
| `cost_cents`       | INTEGER | NOT NULL    |
| `signature`        | TEXT    | NOT NULL    |

Indices:
- `idx_receipts_session` on `session_id`
- `idx_receipts_timestamp` on `timestamp`

#### Table: `receipt_verifications`

| Column                 | Type    | Constraint  |
|------------------------|---------|-------------|
| `receipt_id`           | TEXT    | PRIMARY KEY |
| `signature_valid`      | INTEGER | NOT NULL    |
| `buyer_input_tokens`   | INTEGER | NOT NULL    |
| `buyer_output_tokens`  | INTEGER | NOT NULL    |
| `buyer_total_tokens`   | INTEGER | NOT NULL    |
| `seller_total_tokens`  | INTEGER | NOT NULL    |
| `token_difference`     | INTEGER | NOT NULL    |
| `percentage_difference`| REAL    | NOT NULL    |
| `disputed`             | INTEGER | NOT NULL    |
| `verified_at`          | INTEGER | NOT NULL    |

No additional indices beyond the primary key.

#### Table: `sessions`

| Column              | Type    | Constraint  |
|---------------------|---------|-------------|
| `session_id`        | TEXT    | PRIMARY KEY |
| `seller_peer_id`    | TEXT    | NOT NULL    |
| `buyer_peer_id`     | TEXT    | NOT NULL    |
| `provider`          | TEXT    | NOT NULL    |
| `started_at`        | INTEGER | NOT NULL    |
| `ended_at`          | INTEGER | (nullable)  |
| `total_requests`    | INTEGER | NOT NULL    |
| `total_tokens`      | INTEGER | NOT NULL    |
| `total_cost_cents`  | INTEGER | NOT NULL    |
| `avg_latency_ms`    | REAL    | NOT NULL    |
| `peer_switches`     | INTEGER | NOT NULL    |
| `disputed_receipts` | INTEGER | NOT NULL    |

Indices:
- `idx_sessions_started` on `started_at`
- `idx_sessions_provider` on `provider`

### Maintenance

`pruneOlderThan(timestampMs)` deletes data from all four tables where the relevant timestamp column is older than the given value. Returns counts of deleted rows per table.

---

## Aggregation

The `UsageAggregator` class groups session metrics into time-period buckets for reporting.

### Granularity

| Granularity | Period                                      |
|-------------|---------------------------------------------|
| `daily`     | UTC day (00:00 to next day 00:00)           |
| `weekly`    | Monday 00:00 UTC to next Monday 00:00 UTC  |
| `monthly`   | First of month 00:00 UTC to first of next month 00:00 UTC |

### UsageAggregate Interface

| Field            | Type                                                         | Description                          |
|------------------|--------------------------------------------------------------|--------------------------------------|
| `periodStart`    | `number`                                                     | Start of aggregation period (ms since epoch) |
| `periodEnd`      | `number`                                                     | End of aggregation period (ms since epoch)   |
| `granularity`    | `'daily' \| 'weekly' \| 'monthly'`                           | Granularity of the period            |
| `totalSessions`  | `number`                                                     | Total sessions in this period        |
| `totalRequests`  | `number`                                                     | Total requests                       |
| `totalTokens`    | `number`                                                     | Total estimated tokens               |
| `totalCostCents` | `number`                                                     | Total cost/earnings in USD cents     |
| `byProvider`     | `Record<ProviderType, { requests, tokens, costCents }>`      | Breakdown by provider                |
| `topPeers`       | `Array<{ peerId, requests, tokens, costCents }>`             | Top peers sorted by costCents descending |

### Aggregation Methods

- `aggregate(sessions, granularity, topPeerCount=5)` -- Groups sessions into time-period buckets and returns an array of `UsageAggregate` sorted by `periodStart`
- `aggregateRange(sessions, startDate, endDate, granularity, topPeerCount=5)` -- Filters sessions to the given time range, then aggregates
- `aggregateAll(sessions)` -- Returns a single aggregate spanning all sessions (uses `monthly` granularity label, includes all peers)

### Top Peers

Peers are identified by `sellerPeerId`. They are sorted by `costCents` descending and limited to the top N (default 5). The `aggregateAll` method includes all peers.
