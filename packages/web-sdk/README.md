# @antseed/web-sdk

Browser buyer SDK for Antseed. Connects to unmodified sellers over WebRTC
DataChannels (signaled through an [@antseed/relay](../../apps/relay)) and pays
per request with in-browser EIP-712 signatures. No native modules; the runtime
dependencies are ethers and the workspace's own `@antseed/buyer-core` and
`@antseed/protocol`.

```ts
import { AntseedWebClient } from '@antseed/web-sdk';

const client = await AntseedWebClient.create({
  relayUrl: 'https://relay.example.com',
  privateKey: buyerHotWalletKey,        // peerId = its EVM address
  connection: {
    iceServers: [
      { urls: 'stun:stun.example.com' },
      { urls: 'turns:turn.example.com', username, credential },
    ],
    onConnectionInfo: ({ path }) => showPath(path), // direct | relay | unknown
  },
});

const sellers = await client.sellers();
const session = await client.connect(sellers[0].peerId);

const response = await session.request(
  {
    path: '/v1/chat/completions',
    provider: 'openai',
    headers: { accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'gpt-oss-120b', stream: true, messages: [...] }),
  },
  { onChunk: (data, done) => render(new TextDecoder().decode(data)) },
);
```

## Example page

A working single-page example (seller discovery, connect, streaming chat)
lives in [`examples/example.html`](examples/example.html):

```bash
pnpm --filter @antseed/web-sdk run example
# open http://127.0.0.1:8974/example.html
```

It expects a reachable relay (`node apps/relay/dist/index.js`, default port
8917 — use `RELAY_STATIC_SELLERS=<peerId>@<host>:<port>` to pin a local
seller) and works unfunded against sellers that accept free requests.

## Durable channel state and multiple tabs

By default the client uses an in-memory channel store: on reload the latest
signed SpendingAuth state is gone and reserved funds stay locked until the
session deadline passes. Production apps should inject a durable store:

```ts
const client = new AntseedWebClient({ relayUrl, wallet, channelStore: myStore });
```

`channelStore` takes any `BuyerChannelStore` (re-exported here). For
crash-safety implement the optional `flush()`: it is awaited after each newly
signed authorization is persisted and *before* it is transmitted, so it must
not resolve until the write is durably committed (e.g. IndexedDB behind a
synchronous in-memory cache). If several tabs can share the store, the
implementation must also serialize signing (e.g. `navigator.locks`) —
SpendingAuth amounts are cumulative per channel, and two tabs signing
concurrently corrupt the sequence. Without a shared store, each tab opens its
own channel and reserves its own budget.

## ICE / TURN configuration

`connection.iceServers` accepts bare URL strings or full `RTCIceServer`
entries (for TURN credentials); `connection.iceTransportPolicy: 'relay'`
forces TURN-only paths. `connection.onConnectionInfo` reports the selected
path (`'direct' | 'relay' | 'unknown'`) once connected, without exposing
addresses or raw candidates.

## Architecture

This package contains only the browser-specific pieces: relay signaling
(`hello` envelope, SDP offer, trickle ICE), the `RTCPeerConnection`
transport, keepalive, channel-store adapters, and cross-tab coordination.
Everything else is shared code, not a reimplementation. Production clients
use an IndexedDB store; the in-memory store remains available only through
the explicit `ephemeral()` API:

- **@antseed/protocol** — wire format: message types, frame/HTTP/payment
  codecs, EIP-712 payment signatures, connection auth. Same modules
  @antseed/node runs.
- **@antseed/buyer-core** — the buyer machinery: `BuyerRequestHandler`,
  `BuyerPaymentManager`, `BuyerPaymentNegotiator`, `ProxyMux`/`PaymentMux`.
  The exact classes behind the node/CLI buyer proxy, wired here to a WebRTC
  DataChannel and the configured channel store (in-memory by default).

So 402 negotiation, ReserveAuth/AuthAck, NeedAuth cost validation, cumulative
SpendingAuth metadata, streaming, and chunked uploads behave identically to
the node buyer. One browser-specific override: uploads chunk above 192 KiB
(not the shared 240 KiB `ANTSEED_UPLOAD_THRESHOLD_BYTES`) to keep more headroom
under the ~256 KiB SCTP message ceiling browsers negotiate with libdatachannel
sellers. Defaults target Base mainnet; override
`payment.*` for other chains.

The relay bridge is closed as soon as the DataChannel opens — it is only
needed for signaling, and holding it would consume the relay's per-IP bridge
slots. There is no re-signaling path; a dropped DataChannel means a fresh
`connect()`.

## Persistence and multiple tabs

`AntseedWebClient.create()` is asynchronous because it acquires an exclusive
Web Lock for the buyer identity and hydrates IndexedDB before the payment
manager may sign. Only one tab can use a buyer on the same chain/channels
contract at a time. A second tab fails with `BuyerAlreadyActiveError` by
default; set `persistence.waitForLock` to wait instead. A crashed tab releases
its Web Lock automatically, and its successor recovers the last durably
committed channel state.

Every ReserveAuth and SpendingAuth is committed to IndexedDB before it is
sent. The database contains channel identifiers, signatures, cumulative
amounts, metadata, and recovery context, but never the buyer private key.
Use `onPersistenceError` to surface background failures from ordinary
status/accounting writes immediately; awaited authorization commits and
`close()` also reject when persistence is unhealthy.
Call `await client.close()` when the application is done to flush storage and
release the lock. Page-unload handlers are not a channel recovery mechanism.

`AntseedWebClient.ephemeral()` retains in-memory behavior for tests and free
interoperability experiments. It must not be used for paid traffic because a
reload loses its channel state and it provides no multi-tab exclusion.

`SellerSession.close()` closes only the WebRTC transport. Use
`await session.closeChannel()` to request cooperative settlement from a
supporting seller. `client.listActiveChannels()` exposes locally unresolved
channels for recovery UI. If the seller is unavailable, call
`session.requestOnChainClose(operatorSigner)` and, after the contract grace
period, `session.withdrawTimedOutChannel(operatorSigner)`. The signer must be
the operator configured for the buyer in AntseedDeposits; the SDK does not
assume that the browser wallet or any particular backend owns that role.

The relay verifies DHT metadata before caching it, and the SDK rejects a
non-empty seller snapshot older than `maxSellerSnapshotAgeMs` (15 minutes by
default) before normalizing it into the shared buyer pricing/capability view.
The relay remains a trusted discovery-availability boundary; connection auth,
seller response authentication, and payment signatures remain end to end.

## Known limitation: large non-streamed responses

Chunking currently protects the upload direction only. A seller sends a
non-streamed response body as a single DataChannel message, and browsers cap
received SCTP messages at ~256 KiB — a larger response (e.g. base64 image
output) will kill the DataChannel. Until seller-side response chunking
exists, prefer streaming (`accept: text/event-stream`) for potentially large
responses.

## Prerequisites for paying sellers

The buyer address must have USDC deposited in AntseedDeposits (directly or
via the gasless EIP-3009 sweep). Deposit UX is out of scope for this SDK.

## Testing

`vitest run` covers byte-for-byte parity with `@antseed/node` (hello
envelope, frame codec, EIP-712 signatures, metadata hashing) and an
end-to-end suite that drives the real `@antseed/node` seller listener through
a real relay instance, with `node-datachannel/polyfill` standing in for the
browser's `RTCPeerConnection`. `pnpm run test:browser` additionally launches
real Chromium and Firefox runtimes, connects their native WebRTC stacks to an
unchanged seller through the relay, and verifies multi-tab exclusion plus
crash takeover. The browser suite also completes paid 402 negotiation, verifies
the EIP-712 authorizations, reloads IndexedDB, simulates lost seller state, and
recovers the same on-chain channel without issuing a second reserve.
