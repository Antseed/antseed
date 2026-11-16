# @antseed/node

The runtime around buyer-core and the plugins: P2P transport and identity, discovery, metering, seller request handling and sqlite. It is the plugin host: `src/interfaces/plugin.ts` and `seller-provider.ts` define what a plugin implements, including `serviceApiProtocols`, and the node does everything else. `seller-request-handler.ts` picks a protocol for billing only and never translates; the buyer proxy (`apps/cli/src/proxy/buyer-proxy.ts`) does that. `src/payments/` re-exports the buyer's payment code from buyer-core; the seller side (`seller-payment-manager.ts`, `channel-store.ts`, the chain config) is node's own.

Published to npm. Runs in Node (the CLI, the desktop's CLI child, the gateway); a few subpaths are also bundled into browser code.

## Inside

- `src/node.ts` — `AntseedNode`, one class for both roles; `_wireConnection` wires every mux onto a connection.
- `src/seller-request-handler.ts` — every request a seller receives, in order, from model match through payment checks to metering.
- `src/discovery/metadata/` — the signed metadata codec, one `versions/vNN.ts` per version. A new version: field module, `versions/vNN.ts`, register it in `index.ts`, bump `METADATA_VERSION` in `packages/protocol/src/peer-metadata.ts`.
- `src/p2p/` — identity, `connection-manager.ts` (encrypted TCP first, WebRTC fallback), `connection-auth.ts`, `secure-channel.ts`.
- A migration goes in `src/storage/migrations/<domain>/` (`add-migration` skill). A new subpath needs an `exports` entry in `package.json`.
- Two-line files saying `// Moved to @antseed/buyer-core` or `@antseed/protocol` are re-exports; edit the target package. Most tests are in `tests/`.

| Rule | Enforced by |
| --- | --- |
| A schema change is a new numbered migration in `src/storage/migrations/<domain>/`. A shipped one is never edited. | review only; `add-migration` skill |
| Settle-on-disconnect closes at the latest amount the buyer signed. | `tests/payment-flow-integration.test.ts` (that it settles, not the amount) |
| The peerId is the lowercase 40-hex EVM address of the identity key; one secp256k1 key signs P2P frames and chain messages. Use `identity.wallet` or `peerIdToAddress()`. | `tests/evm-keypair.test.ts`, `tests/identity.test.ts` |
| A shipped metadata version's signed bytes never change. A seller signs every servable version and answers with the newest the buyer's `x-antseed-metadata-version` allows; no header gets `LEGACY_METADATA_VERSION`. | `tests/metadata-golden.test.ts`, `tests/metadata-version-negotiation.test.ts` |
| Custom bootstrap nodes go through `mergeBootstrapNodes(OFFICIAL_BOOTSTRAP_NODES, custom)`, never `??`. Only `noOfficialBootstrap` drops the official nodes. | `tests/bootstrap.test.ts` (the merge only; callers by review) |
| `tcp-enc.v1` and `signed-sdp.v1` fail closed: a stripped capability or offer, a replayed envelope or a substituted SDP is rejected. | `tests/transport-security.test.ts` |
| Only allowlisted upstream response headers reach a buyer (`src/proxy/buyer-response-headers.ts`). An upstream account error becomes a self-health error and never shows the account. | `tests/seller-self-health-error.test.ts` |
| Upstreams that share a provider name offer a shared service on identical terms. A video service has one upstream per name. | `tests/seller-self-health-error.test.ts` |
| A seller settles with the metadata bytes the buyer signed; a SpendingAuth without them settles with its version's zero metadata, so a new version keeps the older `ZERO_METADATA_HASHES` accepted. | `tests/seller-payment-manager.test.ts` |
| Billing uses the upstream's reported usage (`freshInputTokens`, `cachedInputTokens`, `outputTokens`, independent counts). Byte estimates feed pre-checks and buyer limits only. | `tests/seller-receipt-cost.test.ts`, `tests/response-usage.test.ts` |
| On-chain reads for many sellers go through the Multicall clients, never one RPC call per peer. | `tests/trust-signals-client.test.ts` |
| Subpaths the desktop renderer and gateway console import (`model-routing`, `tee-status`, `free-tier-*`, ...) import no Node-only module. `trust-score` does, so browsers must not import it. | review only (their Vite builds fail) |
| Pending sockets, peers and per-IP connections have separate inbound limits, and a connected buyer can reconnect at the limit. One shared socket cap once hid busy sellers from discovery, since `/metadata` shares the signaling port. | `tests/inbound-connection-limits.test.ts` |

## Connections

- Depends on `@antseed/protocol`, `@antseed/buyer-core` and `@antseed/api-adapter` (build tier 0; node's tests import their `dist`, so build them first). Used by the CLI, payments, ants, desktop, gateway, provider-core, router-core and every plugin.
- Release: pnpm publishes `workspace:*` as an exact pin, so a node bump needs cli, payments and ants bumps (`scripts/npm-publish-plan.mjs` checks).
- Kept in sync: `METADATA_VERSION` in `packages/protocol/src/peer-metadata.ts` with the codec registry in `src/discovery/metadata/index.ts` (throws at import without a codec); EIP-712 strings in `packages/protocol/src/signatures.ts` with `packages/contracts`; `src/payments/generated-contract-addresses.ts` is generated from `packages/contracts/deployments/` (`pnpm contracts:check`, not run in CI).
- DHT topics and `SUBNET_COUNT` in `dht-node.ts` are shared by every deployed peer; changing them is a coordinated upgrade. Seller tx fees live in buyer-core's `base-evm-client.ts`.

## Traps

- **Metadata vocabulary.** A version drops services that name a protocol, unit, capability option or match key outside its vocabulary, and `strip()` drops fields it does not carry. A new name or field without a new version reaches no buyer, silently.
- **Reused migration numbers.** A pre-release build once marked metering 004 and 005 applied without running them (`metering/010_repair_free_tier_usage.ts` repairs it). Never reuse a number across branches.
- **AES-256-GCM, not ChaCha20.** Electron's BoringSSL has no `chacha20-poly1305` in `createCipheriv`.
- **node-datachannel can segfault.** `ConnectionManager` probes it in a child process; `webrtc-transport.test.ts` runs in the `forks` pool.
- **Stale comments.** `getChainConfig` falls back to base-mainnet, not base-sepolia; `minBudgetPerRequest` defaults to $0.50, not $0.01; the upload threshold is 240 KiB, not 512 KiB. Trust the code. An upload limit test needs bodies above the threshold and interleaved uploads.
- **Tests and native ABI.** Without `dataDir` the node uses `~/.antseed`, so tests pass a temp dir. `pretest` rebuilds better-sqlite3 when the desktop rebuilt it for Electron.
- **Content-free mode** (`ANTSEED_CONTENT_FREE_LOGS=1`): a seller logs and stores no request or answer text, including in upstream errors.
- **Two plugin loaders.** `src/config/plugin-loader.ts` does not change how the CLI loads plugins (`apps/cli/src/plugins/loader.ts`).

**Ask first:** `src/p2p/identity.ts`, `identity-envelope.ts`, `secure-channel.ts`; a new migration; the plugin interfaces (every plugin implements them); a metadata version or a change to a shipped version's layout; DHT topics or `SUBNET_COUNT`; what a seller charges or when it answers 402; a new native dependency.

**Prove it:** `pnpm --filter "@antseed/node^..." run build`, then `pnpm --filter @antseed/node test` and `typecheck`. A metadata or codec change runs `tests/metadata-golden.test.ts` unchanged. A change to exports or payment types also runs `pnpm --filter @antseed/cli test`.
