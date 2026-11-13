# @antseed/buyer-core

The transport-agnostic buyer machinery, extracted from `@antseed/node` (which
re-exports everything from its original paths, so existing consumers are
unaffected): `BuyerRequestHandler`, `BuyerPaymentManager`,
`BuyerPaymentNegotiator`, `BuyerFreeUsageManager`, the
`ProxyMux`/`PaymentMux`/`VerificationMux` frame multiplexers, pricing and
channel accounting, unit-billing request/response normalization, and the
read-only Deposits/Channels EVM clients.

Depends only on `@antseed/protocol`, `@antseed/api-adapter`, `ethers`, and
`tokenx` — no sqlite, no sockets, no Node-specific APIs.

The environment plugs in through small structural interfaces
(`src/interfaces.ts`, `src/channel-store-types.ts`):

- `BuyerConnection` — `state`, `stateChange` events, `send(bytes)`. Satisfied
  by `@antseed/node`'s `PeerConnection`.
- `BuyerChannelStore` — the channel bookkeeping surface. Satisfied by
  `@antseed/node`'s sqlite `ChannelStore`.
- `BuyerIdentity`, `BuyerPeerView`, `ResponseAuthSink`, `ResponseAuthSampler`
  — identity, peer knowledge, and optional verification persistence.

Implementations don't import this package; compatibility is structural.

**Keeping stored channels honest.** The store can lag the chain: a seller may
close a channel this buyer stopped using. `reconcileStoredChannels({ store,
channels, buyerEvmAddr })` reads every active row of one buyer on-chain and
retires the ones that can never move money again. A closed channel becomes
`settled` and a withdrawn one `timeout`, each with the contract's settled
amount, and a reserve that never landed and whose every ReserveAuth has
expired becomes `ghost`. Unreadable rows and unknown statuses stay active, as
do rows whose reserve can still land. It never leaves a seller with a different
active channel than it had. A process with live buyer sessions calls
`negotiator.reconcileChannelsWithChain()` instead, which also leaves alone a
seller with payment work in flight and drops retired sessions from memory.
