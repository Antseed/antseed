# Security Review: Buyer Proxy Component

**Date:** 2026-03-08
**Reviewer:** Automated Security Audit
**Scope:** `apps/cli/src/proxy/buyer-proxy.ts`, `apps/cli/src/proxy/service-api-adapter.ts`, `packages/node/src/proxy/proxy-mux.ts`, `packages/node/src/proxy/request-codec.ts`, `packages/node/src/payments/buyer-payment-manager.ts`, `packages/node/src/payments/evm/sessions-client.ts`, `packages/node/src/types/buyer.ts`

---

## Summary

- **Findings**: 5 (1 High, 2 Medium, 2 Needs Verification)
- **Confidence**: High/Mixed

---

## Findings

### [VULN-001] Missing Request Body Size Limit — Denial of Service (High)

- **Location**: `apps/cli/src/proxy/buyer-proxy.ts:1107-1112`
- **Confidence**: High
- **Issue**: The HTTP request handler reads the entire incoming request body into memory with no size cap. While the server listens on `127.0.0.1`, any local process (or malware) can send an arbitrarily large body to exhaust the Node.js process memory and crash the proxy.
- **Impact**: Local denial of service. A malicious or buggy local client can OOM the buyer proxy by sending a multi-GB body. This kills the proxy for all other local tools (e.g., Claude CLI) that depend on it.
- **Evidence**:
  ```typescript
  // apps/cli/src/proxy/buyer-proxy.ts:1107-1112
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const body = Buffer.concat(chunks)
  ```
  No `Content-Length` check, no streaming byte limit, no maximum body size enforcement on the HTTP server side. The `ProxyMux` has upload limits on the P2P side (`maxUploadBodyBytes: 32 MiB`), but the HTTP ingress path has none — the body is fully buffered before it reaches the mux.
- **Fix**: Add a request body size limit at the HTTP ingress. Reject requests exceeding a reasonable threshold (e.g., 64 MiB) with HTTP 413:
  ```typescript
  const MAX_BODY_BYTES = 64 * 1024 * 1024 // 64 MiB
  let totalBytes = 0
  for await (const chunk of req) {
    totalBytes += chunk.length
    if (totalBytes > MAX_BODY_BYTES) {
      res.writeHead(413, { 'content-type': 'text/plain' })
      res.end('Request body too large')
      return
    }
    chunks.push(chunk as Buffer)
  }
  ```

---

### [VULN-002] Credential Forwarding to Untrusted P2P Peers (Medium)

- **Location**: `apps/cli/src/proxy/buyer-proxy.ts:1113-1120`
- **Confidence**: High
- **Issue**: All request headers from the local client are forwarded to the remote P2P seller peer, with only the `host` header stripped. When tools like Claude CLI send requests through this proxy, they include sensitive headers such as `authorization: Bearer sk-ant-...`, `x-api-key`, or `anthropic-api-key`. These credentials are forwarded verbatim to an untrusted third-party seller node over the P2P network.
- **Impact**: API key leakage to untrusted peers. A malicious seller receives the buyer's original API credentials and can use them to make direct API calls at the buyer's expense, or resell/exfiltrate them.
- **Evidence**:
  ```typescript
  // apps/cli/src/proxy/buyer-proxy.ts:1113-1120
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(', ')
    }
  }
  // Remove host header (points to localhost, not the seller)
  delete headers['host']
  ```
  Only `host` is removed. Headers like `authorization`, `x-api-key`, `anthropic-api-key`, `cookie`, and `proxy-authorization` are all forwarded.
- **Fix**: Strip sensitive authentication headers before forwarding to sellers:
  ```typescript
  const SENSITIVE_HEADERS = new Set([
    'authorization',
    'x-api-key',
    'anthropic-api-key',
    'openai-api-key',
    'cookie',
    'proxy-authorization',
    'x-goog-api-key',
  ])
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      delete headers[key]
    }
  }
  ```

---

### [VULN-003] Peer Identity Spoofing via Daemon State File (Medium)

- **Location**: `apps/cli/src/proxy/buyer-proxy.ts:951-994` (`_readLocalSeederFallback`)
- **Confidence**: High
- **Issue**: The buyer proxy reads `~/.antseed/daemon.state.json` and trusts it to construct a `PeerInfo` object that bypasses DHT discovery. If any local process (or malware with user-level access) can write to this file, it can redirect all proxy traffic to an attacker-controlled endpoint by setting a crafted `peerId` and `signalingPort`.
- **Impact**: Traffic hijacking. A local attacker writes a spoofed `daemon.state.json` pointing to their own server. All AI API calls are then routed there, allowing interception of prompts, responses, and any forwarded credentials (compounded by VULN-002).
- **Evidence**:
  ```typescript
  // apps/cli/src/proxy/buyer-proxy.ts:951-994
  const DAEMON_STATE_FILE = join(homedir(), '.antseed', 'daemon.state.json')
  // ...
  private async _readLocalSeederFallback(): Promise<PeerInfo | null> {
    const raw = await readFile(DAEMON_STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as { ... }
    if (parsed.state !== 'seeding') return null
    if (typeof parsed.peerId !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.peerId)) return null
    // ...
    return {
      peerId: peerId as PeerInfo['peerId'],
      publicAddress: `127.0.0.1:${Math.floor(signalingPort)}`,
      // ...
    }
  }
  ```
  The file is read with no integrity check. The PID liveness check (`process.kill(pid, 0)`) only verifies *any* process exists at that PID, not that it's a legitimate Antseed seeder.
- **Fix**:
  1. Verify the daemon state file permissions (owner-only `0600`).
  2. Add an HMAC or signature over the state file, verifiable with the node's identity.
  3. Add a cryptographic handshake with the local seeder before routing traffic (e.g., challenge-response over the signaling port).

---

## Needs Verification

### [VERIFY-001] Binary Codec Lacks Bounds Checking — Potential OOB Read

- **Location**: `packages/node/src/proxy/request-codec.ts:86-123` (`decodeHttpRequest`)
- **Question**: The decode functions read length-prefixed fields from a binary buffer but do not validate that declared lengths are within the remaining buffer size. A malicious or corrupted frame with `headerCount = 65535` and/or inflated `bodyLen` could cause out-of-bounds reads. While V8 will throw a `RangeError` (not unsafe memory access like in C), this could be exploited to crash the node process via an unhandled exception path. **Verify**: Are all callers of `decodeHttpRequest` / `decodeHttpResponse` / `decodeHttpRequestChunk` wrapped in try/catch that gracefully handles malformed frames without crashing the process? The `ProxyMux.handleFrame` does wrap in try/catch but re-throws as a new Error — confirm the caller handles it.
  ```typescript
  // packages/node/src/proxy/request-codec.ts:86-100
  export function decodeHttpRequest(data: Uint8Array): SerializedHttpRequest {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    const requestIdLen = view.getUint16(offset); // No check: requestIdLen <= data.length - 2
    offset += 2;
    const requestId = decoder.decode(data.slice(offset, offset + requestIdLen));
    // ...
  }
  ```

### [VERIFY-002] Auto-Acknowledge Receipts Without Amount Validation

- **Location**: `packages/node/src/payments/buyer-payment-manager.ts:183-214` (`handleSellerReceipt`)
- **Question**: When `autoAck` is enabled (default: `true`), the buyer automatically counter-signs every seller receipt without verifying that the `runningTotal` is reasonable relative to actual usage. A malicious seller could inflate `runningTotal` beyond actual costs, and the buyer would sign an acknowledgment that could later be used in on-chain settlement for a larger amount. **Verify**: Does the on-chain channels contract cap settlement at `lockedAmount`? If so, the blast radius is limited to the locked amount. If not, this is a High severity financial loss vector.
  ```typescript
  // packages/node/src/payments/buyer-payment-manager.ts:193-213
  const autoAck = this._config.autoAck ?? true;
  if (autoAck) {
    // Signs receipt.runningTotal without comparing to expected cost
    const ackMsg = buildAckMessage(sessionIdBytes, BigInt(receipt.runningTotal), receipt.requestCount);
    const sigBytes = await signData(this._identity, ackMsg);
    paymentMux.sendBuyerAck({ ... });
  }
  ```

---

## Additional Observations (Defense-in-Depth, Not Findings)

| Area | Observation |
|------|-------------|
| **Listening interface** | Proxy correctly binds to `127.0.0.1` only — no remote access exposure. ✅ |
| **Session ID generation** | Uses `crypto.randomBytes(32)` for session IDs — strong entropy. ✅ |
| **Request ID** | Uses `crypto.randomUUID()` — good. ✅ |
| **Upload limits (P2P side)** | `ProxyMux` enforces per-request (32 MiB) and global (256 MiB) upload limits with stall timeouts, and zeros intermediate buffers after reassembly. ✅ |
| **Sensitive data in RAM** | `ProxyMux` zeros chunked upload buffers after use (`chunk.fill(0)`). Good practice. ✅ |
| **Debug logging** | Debug mode is off by default; when enabled, request/response shapes are logged but body contents are not logged directly. Request bodies are parsed for shape summaries only. Low risk. |
| **Telemetry headers** | Response headers expose peer metadata (`x-antseed-peer-id`, `x-antseed-peer-address`, pricing, reputation). These are returned to the local client only. Acceptable for localhost. |
| **ECDSA / secp256k1 signatures** | Payment signatures use `ethers` library's `signMessage` via the node identity. Signature construction uses domain-separated `solidityPackedKeccak256` with type prefixes (`0x01`, `0x02`). ✅ |
| **Retry logic** | Retries (max 3) evict failing peers from cache and report failures to the router. No amplification risk since retries target different peers. ✅ |

---

*This review focused on exploitable vulnerabilities with attacker-controlled input. Theoretical issues, test files, and best-practice-only items were excluded per review policy.*
