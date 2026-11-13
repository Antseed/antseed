---
slug: /transport
title: Transport
description: Connection handshake, transport modes, binary framing, and every message type on the Antseed peer-to-peer wire.
hide_title: true
---

# Transport

The transport layer carries all buyer-seller traffic over direct, authenticated peer-to-peer connections. Between nodes the preferred transport is encrypted TCP; WebRTC DataChannels (via `node-datachannel`) serve peers that cannot open TCP sockets. Every message is a binary frame, and proxied HTTP requests keep their original API format, so existing tools work without modification.

## Transport modes

Transport selection is capability-driven; a node advertises what it supports in its signed discovery metadata.

| Mode | Library | Description |
|---|---|---|
| Encrypted TCP (`transport.tcp-enc.v1`) | Node.js net | **Preferred.** Direct TCP with a mutually authenticated, encrypted channel: wallet-signed ephemeral X25519 keys, HKDF-SHA256, one AES-256-GCM key per direction |
| Plaintext TCP | Node.js net | Legacy fallback for peers that do not advertise encrypted TCP |
| WebRTC (`transport.webrtc.v1`) | node-datachannel | WebRTC DataChannel (DTLS) via TCP signaling, for peers that cannot use TCP directly |

An initiator uses encrypted TCP whenever the peer supports it, WebRTC only for peers that advertise WebRTC but not encrypted TCP, and plaintext TCP only with legacy peers. Once encryption is offered, a handshake timeout fails closed; it never downgrades to plaintext. Encrypted TCP is preferred partly because WebRTC DataChannel messages are capped at 256 KiB, below the protocol's frame sizes.

## Seller networking

A seller must announce an address that buyers can reach from the public internet. The default seller signaling/TCP port is `6882`; the DHT port is `6881`. `seller.publicAddress` should point to the public hostname or IP and the externally reachable signaling port, not a LAN address such as `192.168.x.x` or `10.x.x.x`.

```bash
antseed config seller set publicAddress "seller.example.com:6882"
antseed seller doctor
```

`antseed seller start` prints a prominent warning when `publicAddress` is empty or uses a loopback, private, link-local, unspecified, or multicast IP. `antseed seller doctor` classifies the configured address and attempts a bounded TCP connection from the seller machine. A successful local connection is useful but does **not** prove that inbound NAT traversal works; verify the same endpoint from a different network before considering the seller reachable.

### Home or office NAT

1. Give the seller machine a stable LAN address.
2. Forward the external TCP port (normally `6882`) on the router to the seller machine's signaling port.
3. Allow inbound TCP traffic on that port in the host and cloud firewalls.
4. Set `seller.publicAddress` to the router's public IP or a DNS name that resolves to it.
5. Test the endpoint from a cellular connection, remote host, or another external network.

Some routers do not support NAT loopback (hairpinning), so a local probe to the public address can fail even when external clients can connect. Conversely, a local listener can succeed while the router still blocks inbound traffic. Carrier-grade NAT (CGNAT) usually prevents port forwarding entirely; request a public IP from the ISP or use a VPS pattern instead.

### VPS and reverse tunnels

The simplest production deployment is a VPS with a public IP: allow inbound TCP on the announced port and run the seller there. If inference must remain on a private machine, expose its signaling port through a stable TCP reverse tunnel or gateway on a VPS, then announce the VPS hostname and public port. Configure the tunnel as a supervised service so it reconnects after restarts, and restrict firewall access to only the required ports.

Do not announce SSH-only tunnels, private VPN addresses, or temporary tunnel hostnames that buyers cannot reach. Re-run `antseed seller doctor` and an external connection test after changing DNS, firewall, router, or tunnel settings.

## Connection handshake

Every connection opens with one signed JSON line before any binary frame. TCP connections send an `intro` line; WebRTC signaling sends `hello`. The line carries the sender's capabilities and an authentication envelope:

```json title="intro line"
{
  "type": "intro",
  "auth": { "peerId": "<peerId>", "ts": 1760000000000, "nonce": "<32 hex chars>", "sig": "<130 hex chars>", "v": 2 },
  "capabilities": ["transport.tcp-enc.v1", "payments.cooperative-close.v1"],
  "enc": { "pub": "<X25519 public key>", "sig": "<signature>" }
}
```

- `sig` is an EIP-191 `personal_sign` over `antseed-msg-v1:` followed by `intro|<peerId>|<ts>|<nonce>`. Version 2 envelopes (`"v": 2`) also sign the capability list and the encryption public key (`…|caps=<JSON>|enc=<pub or ->`), so neither can be stripped or altered in transit.
- The receiver recovers the signer with `ecrecover`, checks it matches `peerId`, rejects timestamps more than 30 seconds off its clock, and rejects nonces it has already seen.
- The initial line must arrive within 10 seconds and is capped at 8 KiB.
- With encrypted TCP, the `enc` offer carries a signed ephemeral X25519 key. The responder answers with a signed `enc-ack` line whose signature also covers the initiator's nonce, which gives mutual authentication. Everything after `enc-ack` is encrypted frames.
- With WebRTC, peers that advertise `transport.signed-sdp.v1` sign the SDP hash, which binds the DTLS fingerprint to the wallet identity.

## Frame format

```text title="frame header (9 bytes)"
Offset  Size  Type          Field
0       1     uint8         type (message type)
1       4     uint32 BE     messageId
5       4     uint32 BE     payloadLength
```

The maximum payload is 64 MiB; larger frames are rejected. Proxy, keepalive, payment, verification, and sweep messages share this header and one connection. Payment payloads are JSON.

## Message types

This is the complete list from `packages/protocol/src/messages.ts`.

| Hex | Name | Direction | Purpose |
|---|---|---|---|
| 0x10 | Ping | Either | Keepalive probe |
| 0x11 | Pong | Either | Keepalive response |
| 0x20 | HttpRequest | Buyer → seller | Proxied HTTP request |
| 0x21 | HttpResponse | Seller → buyer | Complete response, or the head of a streamed response |
| 0x22 | HttpResponseChunk | Seller → buyer | Streaming body chunk |
| 0x23 | HttpResponseEnd | Seller → buyer | Final chunk |
| 0x24 | HttpResponseError | Seller → buyer | Error response |
| 0x25 | HttpRequestChunk | Buyer → seller | Chunked upload body (bodies over 240 KiB, sent in 8 KiB chunks) |
| 0x26 | HttpRequestEnd | Buyer → seller | End of a chunked upload |
| 0x27 | HttpResponseAck | Buyer → seller | Flow-control acknowledgement for large downloads such as video |
| 0x28 | HttpRequestCancel | Buyer → seller | Cancel an in-flight download |
| 0x50 | SpendingAuth | Buyer → seller | EIP-712 SpendingAuth, plus a ReserveAuth when opening or topping up a channel |
| 0x51 | AuthAck | Seller → buyer | `reserve()` confirmed on-chain |
| 0x52 | FreeUsageOpen | Buyer → seller | Open a zero-price usage channel |
| 0x53 | FreeUsageAuth | Buyer → seller | Signed cumulative zero-price usage record |
| 0x54 | FreeUsageAck | Seller → buyer | Free usage open or record accepted |
| 0x55 | NeedFreeUsageAuth | Seller → buyer | Ask the buyer to sign usage for a completed free request |
| 0x56 | PaymentRequired | Seller → buyer | Sent with an HTTP 402: payment terms, or the amount needed to continue an exhausted channel |
| 0x58 | NeedAuth | Seller → buyer | Cost and usage of the last request, and the cumulative amount the buyer must sign next |
| 0x59 | CloseChannelRequest | Buyer → seller | Ask the seller to close a channel now (cooperative close) |
| 0x5A | CloseChannelResult | Seller → buyer | Close transaction hash, or a rejection code |
| 0x80 | VerificationResponseAuth | Seller → buyer | Seller-signed hash commitment for a completed response |
| 0xA0 | SweepRequest | Buyer → peers | Signed gasless deposit sweep for a relayer to submit |
| 0xA1 | SweepReceipt | Relayer → buyer | Optional sweep progress report |

Types 0x01-0x02 (HandshakeInit/HandshakeAck), 0x60-0x61 (reports), 0x70-0x72 (ratings), and 0xF0/0xFF (Disconnect/Error) are defined in the enum but not sent; the handshake is the signed `intro` line above. The range 0x90-0x9F is reserved.

## Capabilities

Peers announce capability strings in the handshake and in signed discovery metadata. Optional features are used only when the other side advertises them.

| Capability | Meaning |
|---|---|
| `transport.tcp-enc.v1` | Supports encrypted TCP |
| `transport.webrtc.v1` | Has a working WebRTC stack and accepts `hello` signaling |
| `transport.signed-sdp.v1` | Signs WebRTC SDP |
| `payments.cooperative-close.v1` | Seller honours CloseChannelRequest (0x59/0x5A) |
| `payments.relays-sweeps.v1` | Peer relays SweepRequest (0xA0) on-chain |
| `verification.response-auth.v1` | Seller sends VerificationResponseAuth (0x80) |
| `seller.model-health.v1` | Seller self-checks its models and stops advertising ones that fail |

## Keepalive

| Parameter | Value |
|---|---|
| Ping interval | 15 seconds |
| Pong timeout | 5 seconds |
| Max missed pongs | 3 (connection declared dead) |

## Payment negotiation

When a buyer sends a request without an active channel, the seller answers with HTTP 402 and a PaymentRequired (0x56) frame carrying the seller's prices and a suggested amount. The buyer node handles this internally: it signs a ReserveAuth and a SpendingAuth, sends them in a SpendingAuth (0x50) frame, waits up to 30 seconds for AuthAck (0x51) after the seller's on-chain `reserve()`, then retries the original request.

```text title="payment negotiation"
Buyer                           Seller                          Chain
  ├── HttpRequest (0x20) ────────>│                               │
  │<── 402 + PaymentRequired (0x56)┤                               │
  ├── SpendingAuth (0x50) ───────>│                               │
  │   (ReserveAuth + SpendingAuth)├── reserve() ─────────────────>│
  │<── AuthAck (0x51) ────────────┤<── confirmed ─────────────────┤
  ├── HttpRequest (0x20) ────────>│   retry, served normally      │
  │<── HttpResponse (0x21) ───────┤                               │
  │<── NeedAuth (0x58) ───────────┤   cost of that request        │
  ├── SpendingAuth (0x50) ───────>│   new cumulative amount       │
```

After each served request the seller sends NeedAuth (0x58) with the request's cost and token usage; the buyer checks it and signs the new cumulative amount. An application can also supply a pre-signed authorization in the `x-antseed-spending-auth` header (base64), which the buyer node strips and forwards as a SpendingAuth frame. Channel economics, top-ups, and free usage are described in [Payments](/docs/payments).
