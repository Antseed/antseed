# 02 - Transport

This document specifies the transport protocol for peer-to-peer communication in the Antseed Network, covering identity, framing, handshake, connection management, keepalive, reconnection, and HTTP-over-P2P multiplexing.

## Identity

Each node holds a persistent secp256k1 identity used for authentication and peer identification.

### Key Storage

- Algorithm: secp256k1 (via `ethers`)
- **Recommended**: set via `ANTSEED_IDENTITY_HEX` env var (64 hex chars, optional `0x` prefix)
- Fallback: plaintext file `~/.antseed/identity.key` (hex-encoded, `0o600` permissions) — **not recommended for production**

The identity private key can be provided via the `ANTSEED_IDENTITY_HEX` env var (recommended) or read from `~/.antseed/identity.key`. If neither exists, the node generates a random secp256k1 private key and writes it to disk. For production, always use the env var with a secrets manager rather than the plaintext file.

### PeerId Derivation

- PeerId = lowercase hex encoding of the 20-byte EVM address (no `0x` prefix)
- Validated by regex: `^[0-9a-f]{40}$`
- See [00-conventions.md](./00-conventions.md) for full PeerId format

### Signing and Verification

| Operation | Function | Input | Output |
|---|---|---|---|
| Sign (async) | `signData(wallet, data)` | ethers Wallet, arbitrary `Uint8Array` | 65-byte secp256k1 signature |
| Verify (async) | `verifySignature(address, signature, data)` | 20-byte EVM address, 65-byte signature, arbitrary `Uint8Array` | `boolean` (via ecrecover) |
| Sign UTF-8 | `signUtf8(wallet, message)` | ethers Wallet, UTF-8 string | hex-encoded 65-byte signature |
| Verify UTF-8 | `verifyUtf8(address, message, signatureHex)` | EVM address hex, UTF-8 string, hex signature | `boolean` |

All signing uses EIP-191 personal_sign with domain tags. Verification uses ecrecover to recover the signer address and compares it to the expected address. The `ethers` library is used for all cryptographic operations.

## Frame Protocol

All messages are transmitted as binary frames. A frame consists of a fixed-size header followed by a variable-length payload.

### Frame Header

```
Offset  Size  Type          Field
0       1     uint8         type (MessageType)
1       4     uint32 BE     messageId
5       4     uint32 BE     payloadLength
---
Total: 9 bytes
```

- `FRAME_HEADER_SIZE` = **9** bytes
- `MAX_PAYLOAD_SIZE` = **67,108,864** bytes (64 * 1024 * 1024 = 64 MB)

If `payloadLength` exceeds `MAX_PAYLOAD_SIZE`, the frame MUST be rejected with an error.

### Message Types

| Hex  | Name               | Direction / Purpose |
|------|--------------------|---------------------|
| 0x01 | HandshakeInit      | Initiator -> Responder |
| 0x02 | HandshakeAck       | Responder -> Initiator |
| 0x10 | Ping               | Keepalive probe |
| 0x11 | Pong               | Keepalive response |
| 0x20 | HttpRequest        | Buyer -> Seller: proxy request |
| 0x21 | HttpResponse       | Seller -> Buyer: complete response |
| 0x22 | HttpResponseChunk  | Seller -> Buyer: streaming chunk |
| 0x23 | HttpResponseEnd    | Seller -> Buyer: final streaming chunk |
| 0x24 | HttpResponseError  | Seller -> Buyer: error response |
| 0xA0 | SweepRequest       | Buyer -> Peers: broadcast signed gasless deposit sweep (see 09-deposit-sweep.md) |
| 0xA1 | SweepReceipt       | Relayer -> Buyer: optional sweep progress report (see 09-deposit-sweep.md) |
| 0xF0 | Disconnect         | Graceful disconnect notification |
| 0xFF | Error              | Protocol-level error |

Ranges 0x50-0x5F (payments), 0x80-0x8F (verification), 0x90-0x9F (reserved:
delegated verification), and 0xA0-0xAF (deposit sweep) are dispatched to
dedicated per-range muxes; see their spec files for payload schemas.

### Streaming Frame Decoder

A `FrameDecoder` accumulates incoming byte chunks and yields complete `FramedMessage` objects as they become available. Partial frames are buffered until enough data arrives.

### Message Multiplexer

A `MessageMux` routes decoded frames to registered handlers by `MessageType`. An optional default handler catches unregistered types.

## Handshake

The handshake authenticates both peers using secp256k1 challenge-response.

### Constants

| Constant | Value |
|---|---|
| Nonce size | 32 bytes (crypto random) |
| Handshake timeout | 10,000 ms (10 seconds) |
| HandshakeInit payload size | 117 bytes (20 + 32 + 65) |
| HandshakeAck payload size | 117 bytes (20 + 32 + 65) |

### HandshakeInit Payload

```
Offset  Size  Field
0       20    address       Initiator's EVM address
20      32    nonce         Random 32-byte challenge nonce
52      65    signature     secp256k1 signature of nonce by initiator's private key
---
Total: 117 bytes
```

### HandshakeAck Payload

```
Offset  Size  Field
0       20    address       Responder's EVM address
20      32    remoteNonce   Echo of the initiator's nonce
52      65    signature     secp256k1 signature of remoteNonce by responder's private key
---
Total: 117 bytes
```

### Protocol Flow

1. **Initiator** generates a random 32-byte nonce, signs it with its private key, and sends a `HandshakeInit` frame.
2. **Responder** receives the `HandshakeInit`, extracts the initiator's address and nonce, recovers the signer address from the signature via ecrecover and verifies it matches the claimed address.
3. If valid, the **Responder** signs the initiator's nonce with its own private key and sends a `HandshakeAck` frame.
4. **Initiator** receives the `HandshakeAck`, verifies that the echoed nonce matches the original, and recovers the signer address from the signature via ecrecover to verify the responder's identity.
5. On success, both sides transition to `Authenticated` state. On failure, the connection transitions to `Failed`.

### Validation Rules

- If the payload length is not exactly 117 bytes, the handshake MUST fail.
- The echoed nonce in `HandshakeAck` MUST match the original nonce byte-for-byte.
- The address recovered via ecrecover from the signature MUST match the claimed address in the payload.

## Connection

### Transport Modes

Connections support three transports. **Encrypted TCP is the preferred transport between nodes**; WebRTC exists for peers that cannot open TCP sockets (e.g. browsers). Plaintext TCP is a legacy fallback.

| Mode | Library | Description |
|---|---|---|
| `tcp` + `transport.tcp-enc.v1` | Node.js `net` | **Preferred.** Direct TCP with a mutually authenticated encrypted channel |
| `tcp` (plaintext) | Node.js `net` | Legacy fallback for peers that do not advertise `transport.tcp-enc.v1` |
| `webrtc` | `node-datachannel` | WebRTC DataChannel (DTLS) via a TCP signaling socket |

Selection is capability-driven. An initiator uses:

1. **Encrypted TCP** when the remote advertises `transport.tcp-enc.v1` (in discovery metadata or its intro/hello capabilities), or when `requireSecureTransport` is set.
2. **WebRTC** only when the remote advertises `transport.webrtc.v1` but *not* `transport.tcp-enc.v1`, and the local node-datachannel stack passed its startup probe. Nodes advertise `transport.webrtc.v1` only when that probe succeeds; a node without a working stack refuses `hello` signaling.
3. **Plaintext TCP** otherwise (legacy peers).

Note: WebRTC DataChannel messages are capped at 256 KiB, which is why encrypted TCP is preferred for node-to-node traffic and why single request frames stay below `ANTSEED_UPLOAD_THRESHOLD_BYTES` (240 KiB).

### Encrypted TCP (`transport.tcp-enc.v1`)

- The initiator's `intro` line carries an `enc` offer: an ephemeral X25519 public key signed by the initiator's wallet, bound to the intro envelope's ts/nonce.
- The responder answers with a single `enc-ack` line: its own signed ephemeral key, whose signature also covers the initiator's nonce (freshness + mutual authentication — the initiator verifies the ack's peerId against the peer it dialed).
- Session keys: HKDF-SHA256 over the X25519 shared secret, salted with a transcript hash binding both peer ids, both nonces, and both public keys. One AES-256-GCM key per direction.
- All subsequent traffic is length-prefixed AEAD frames (`u32be length | ciphertext+tag`) with implicit per-direction counter nonces. Ephemeral keys give forward secrecy.
- Once an `enc` offer is sent, the handshake fails closed — there is no downgrade to plaintext.

### Data Channel

- Label: `"antseed-data"`
- Options: `{ ordered: true }`

### Initial Wire Protocol

When a TCP socket connects (any mode), the first line is a JSON object terminated by `\n`:

| Type | Fields | Mode | Purpose |
|---|---|---|---|
| `"intro"` | `auth`, `capabilities?`, `enc?` | TCP direct | Authenticates the connecting peer; optionally opens the encrypted-transport handshake |
| `"hello"` | `auth`, `capabilities?` | WebRTC | Authenticates the connecting peer for WebRTC signaling |

`auth` is a signed envelope `{ peerId, ts, nonce, sig, v? }` (EIP-191 over `type|peerId|ts|nonce`, replay-guarded, ±30 s skew). When `v: 2`, the signature additionally covers the JSON-encoded `capabilities` array and the `enc` public key, so a man-in-the-middle cannot strip the encryption offer or capabilities to force a legacy fallback. Peers send v2 whenever the remote is known to support it.

After the initial line: in plaintext TCP mode the socket carries raw frame data; in encrypted TCP mode it carries AEAD frames after the `enc-ack`. In WebRTC mode the socket carries JSON signaling messages until the DataChannel opens, after which the DataChannel carries frame data. Each `sdp` signaling message carries a signed envelope over the exact SDP string (which contains the DTLS certificate fingerprint), binding the DTLS session to the peer's wallet identity; ICE candidates are unsigned because DTLS still verifies the certificate against the signed fingerprint.

### Connection States

```
Connecting -> Open -> Authenticated -> Closing -> Closed
     |                    |
     +--> Failed <--------+
```

| State | Description |
|---|---|
| `Connecting` | Transport is being established |
| `Open` | Transport is open (TCP socket connected or DataChannel opened) |
| `Authenticated` | Handshake completed and verified |
| `Closing` | Graceful shutdown in progress |
| `Closed` | Connection terminated normally |
| `Failed` | Connection terminated due to error |

### Timeouts

| Timeout | Value |
|---|---|
| Initial line timeout (inbound socket) | 10,000 ms (10 seconds) |
| Default connection timeout | 30,000 ms (30 seconds) |

## Keepalive

The keepalive mechanism detects dead connections using Ping/Pong frames.

### Constants

| Constant | Value |
|---|---|
| Ping interval | 15,000 ms (15 seconds) |
| Pong timeout | 5,000 ms (5 seconds) |
| Max missed pongs | 3 |

### Ping Payload

```
Offset  Size  Type          Field
0       8     BigUint64 BE  timestamp (Unix ms)
---
Total: 8 bytes
```

The timestamp is the sender's `Date.now()` value at the time the ping is sent.

### Pong Payload

The Pong payload is an exact echo of the Ping payload (8 bytes).

### Behavior

1. After authentication, the keepalive manager starts sending `Ping` frames every 15 seconds.
2. For each `Ping`, a pong timeout of 5 seconds is started.
3. If a `Pong` is received before the timeout, the missed counter resets to 0 and latency is computed as `Date.now() - pingTimestamp`.
4. If the pong timeout fires without a `Pong`, the missed counter increments by 1.
5. When the missed counter reaches 3, the connection is declared dead and the `onDead` callback fires.

## Reconnection

Reconnection uses exponential backoff with jitter.

### Constants

| Constant | Value |
|---|---|
| Base delay | 1,000 ms (1 second) |
| Max delay | 30,000 ms (30 seconds) |
| Max attempts | 5 |
| Jitter factor | 0.3 |

### Delay Formula

```
delay = min(baseDelay * 2^attempt + jitter, maxDelay)
```

Where:
- `attempt` is zero-indexed (0 for the first attempt)
- `jitter = baseDelay * 2^attempt * jitterFactor * random()` where `random()` is in `[0, 1)`

### Behavior

1. On connection loss, the reconnect manager schedules the first attempt after `calculateDelay(0)`.
2. The attempt counter increments before each `onReconnect` callback invocation.
3. If `onReconnect` returns `true`, the reconnection succeeds and the manager stops.
4. If `onReconnect` returns `false` or throws, the next attempt is scheduled.
5. After `maxAttempts` (5) failed attempts, `onGiveUp` is called and the manager stops.
6. On success, `onSuccess` is called with the attempt number.
7. Calling `reset()` resets the attempt counter to 0 and stops the manager.

## HTTP-over-P2P

HTTP requests and responses are serialized into binary format and multiplexed over the frame protocol.

### Serialized Types

#### SerializedHttpRequest

| Field | Type | Description |
|---|---|---|
| `requestId` | `string` | UUID (generated via `crypto.randomUUID()`) |
| `method` | `string` | HTTP method (GET, POST, etc.) |
| `path` | `string` | Request URL path |
| `headers` | `Record<string, string>` | Flattened HTTP headers (array values joined with `", "`) |
| `body` | `Uint8Array` | Raw request body |

#### SerializedHttpResponse

| Field | Type | Description |
|---|---|---|
| `requestId` | `string` | Matches the originating request |
| `statusCode` | `number` | HTTP status code |
| `headers` | `Record<string, string>` | Response headers |
| `body` | `Uint8Array` | Raw response body |

#### SerializedHttpResponseChunk

| Field | Type | Description |
|---|---|---|
| `requestId` | `string` | Matches the originating request |
| `data` | `Uint8Array` | Chunk data |
| `done` | `boolean` | `true` if this is the final chunk |

### Binary Codec: HttpRequest

```
[requestIdLen:2 BE uint16][requestId:N bytes]
[methodLen:1 uint8][method:N bytes]
[pathLen:2 BE uint16][path:N bytes]
[headerCount:2 BE uint16]
  for each header:
    [keyLen:2 BE uint16][key:N bytes]
    [valLen:2 BE uint16][val:N bytes]
[bodyLen:4 BE uint32][body:N bytes]
```

### Binary Codec: HttpResponse

```
[requestIdLen:2 BE uint16][requestId:N bytes]
[statusCode:2 BE uint16]
[headerCount:2 BE uint16]
  for each header:
    [keyLen:2 BE uint16][key:N bytes]
    [valLen:2 BE uint16][val:N bytes]
[bodyLen:4 BE uint32][body:N bytes]
```

### Binary Codec: HttpResponseChunk

```
[requestIdLen:2 BE uint16][requestId:N bytes]
[done:1 uint8 (0 or 1)]
[dataLen:4 BE uint32][data:N bytes]
```

### ProxyMux

The `ProxyMux` multiplexes multiple HTTP request/response exchanges over a single `PeerConnection`.

#### Buyer Side (outbound requests)

1. `sendProxyRequest(request, onResponse, onChunk)` encodes the request, wraps it in an `HttpRequest` frame, and sends it. Response and chunk handlers are registered by `requestId`.
2. On receiving an `HttpResponse` frame, the response handler fires and both handlers are cleaned up.
3. On receiving `HttpResponseChunk` frames, the chunk handler fires for each chunk.
4. On receiving an `HttpResponseEnd` frame, the chunk handler fires with the final chunk and both handlers are cleaned up.
5. On receiving an `HttpResponseError` frame, the response handler fires with the error response and both handlers are cleaned up.

#### Seller Side (inbound requests)

1. `onProxyRequest(handler)` registers a handler for incoming `HttpRequest` frames.
2. `sendProxyResponse(response)` sends a complete `HttpResponse` frame.
3. `sendProxyChunk(chunk)` sends an `HttpResponseChunk` frame (or `HttpResponseEnd` if `chunk.done` is `true`).

Message IDs are assigned sequentially via an auto-incrementing counter starting at 0.
