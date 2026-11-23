# @antseed/keyed-relay

The seller-keyed blind relay. A seller serves a `seller-blind` service with its own upstream key: the buyer runs TLS to the upstream through the seller, proves the session keys in zero knowledge, and the seller writes the request head with its key as the session's first record without being able to read the session. The buyer never sees the key. Before the seller forwards the request, the buyer reveals its headers and the body's last fields for the seller's check; after the answer, only the status line and the usage the seller bills by.

The cryptography is a Rust sidecar in `native/` built on TLSNotary's building blocks (the ZK VM, the TLS 1.2 PRF circuit, the AES circuit) at the revisions in `native/Cargo.toml`. `src/index.ts` spawns it and speaks its framing; `@antseed/node` (seller, `SellerBlindRelay`) and the CLI (buyer, `apps/cli/src/proxy/keyed-relay-client.ts`) use it.

## Inside

- `native/src/zk.rs` — the key proof (PRF and both Finished checks) and the keystream it reveals: the keystream of the seller's record, the request ranges the buyer reveals for the seller's check, and at the end the response ranges it reveals for billing. It also proves, unrevealed, the powers of the client GHASH key the seller's record needs.
- `native/src/tag.rs` — the tag of the seller's record, computed by both sides from those proven powers: the seller gets that one tag, and neither the GHASH key nor the tag mask.
- `native/src/seller.rs`, `native/src/buyer.rs` — the two roles; `records.rs` the TLS 1.2 record layer and the seller's record; `ranges.rs` maps stream ranges onto records; `frames.rs` the stdin/stdout framing; `session.rs` the buyer ↔ seller mux.
- The request check itself is Node's: `checkKeyedRequest` in `packages/node/src/keyed-relay-request.ts`, on the tail `keyedRequestTailFields` (`packages/protocol`) defines and the CLI's `keyedRequestBody` writes.
- `scripts/platform-package.mjs` and `.github/workflows/keyed-relay-binaries.yml` — the per-platform npm packages the resolver finds. `scripts/declare-platform-packages.mjs` lists them as optional dependencies in the manifest the npm-publish workflow publishes (never in git: a lockfile cannot hold a package npm does not have yet), and fails until the binaries workflow has published them for that version.

| Rule | Enforced by |
| --- | --- |
| The seller writes its record only after the certificate, the server signature, AES-128-GCM, ALPN `http/1.1` and the key proof all check out. | `test/sidecar.test.mjs` (certificate), review |
| The buyer never receives the seller's record; nothing secret crosses the relay in plaintext. | `test/sidecar.test.mjs` |
| Every keystream the seller gets is decoded from the ZK VM, never sent by the buyer: a buyer-chosen keystream would let it flip the seller's head. The one value the buyer sends is its part of the record's tag, and a wrong one only makes the upstream refuse the record. | review only |
| The seller never holds the client GHASH key or a tag mask: with either it could change a record the buyer wrote and fix its tag. It gets the tag of its own record and nothing more, and what it holds re-tags no other record. | `native/src/zk.rs` tests, `native/src/tag.rs` tests, `native/src/records.rs` tests |
| The buyer answers the tag exchange once per session, with the tag mask of the seller's sequence number only. Two answers added together lose the mask and tell the seller about the GHASH key. | review only |
| One request per session: the head ends with `Connection: close` and the credential is never its last header. | `packages/node/tests/keyed-relay.test.ts` |
| The seller forwards nothing of the buyer's request until Node admits it, then only that request's bytes (alerts after it, no more application data). A refused request never reaches the upstream. | `native/src/seller.rs` tests, `test/sidecar.test.mjs`, `apps/cli/src/proxy/blind-relay.test.ts` |
| The seller admits a request only on its full header block (allow-listed headers, a true `Content-Length`) and the canonical last fields, byte for byte. | `packages/node/tests/keyed-relay.test.ts` |
| The seller bills the revealed usage only from a tail that runs to the end of the response and starts at a `data:` event or the `"usage":` key. | `packages/node/tests/keyed-relay.test.ts` |
| The seller sidecar hands Node each revealed range whole, joined across the TLS records it spans: an upstream ends a chunked body in a record of its own, and Node bills and checks only a range that runs to the end. | `native/src/ranges.rs` tests, `test/sidecar.test.mjs` |
| The buyer picks the billing reveal in the body without its chunk framing: from the last usage figure (in a stream, from the `data:` that starts its line) to the end. An answer in another form than the request asked for reveals the status line only, and so does a body that did not end or a tail that holds any of the answer: every string in it is a short label (`id`, `model`, a finish reason, a role) and the rest is figures. | `apps/cli/src/proxy/blind-relay.test.ts` |
| What the seller sidecar holds for a buyer before Node admits its request is bounded: the handshake's length, the number of records of a request, and two alerts of the one valid size. A record without plaintext is refused. An answer that has not ended by the response deadline is cut off and reported. | `native/src/seller.rs` tests, `test/sidecar.test.mjs` |
| The seller sidecar keeps an answer for the reveal that ends the session, so the answer it keeps and relays is bounded too (`maxResponseBytes`, counting what each record costs to keep). An answer that passes it is cut off before the bytes that pass it, and what was relayed is reported. | `native/src/seller.rs` tests, `test/sidecar.test.mjs` |
| A reveal costs the seller sidecar a bounded amount of proof work: its ranges follow one another without overlap, and their number and total length are capped (`ranges::place`) before any circuit is built, for the request and for the response. | `native/src/ranges.rs` tests |
| Sidecar output waiting for a peer stream nobody reads is bounded for a seller (`maxPeerQueueBytes`); past it the peer stream ends, and the sidecar's events still arrive. | `test/sidecar.test.mjs` |
| A buyer that leaves mid-answer is still reported: the seller sidecar emits `responseEnd` with what it relayed before it exits. A destroyed peer stream tells the sidecar its peer is gone and stops it only after a grace period, and a seller's handle stays busy until its sidecar has exited. | `test/sidecar.test.mjs`, `packages/node/tests/keyed-relay.test.ts` |
| A sidecar that cannot start, or that ends before the answer does, ends the request with an error instead of leaving it open. | `test/sidecar.test.mjs`, `apps/cli/src/proxy/blind-relay.test.ts` |
| The wrapper reports a sidecar's exit only after its stdout and stderr have ended, so every frame it wrote arrives before `exit`; a sidecar that never started still reports its exit. | `test/sidecar.test.mjs` |
| A sidecar exits only after every frame it queued has been written to its stdout, after an error too: a parent that reads late still gets a seller's `responseEnd`. A parent that is gone does not hold it up, and one that reads nothing holds it up for a bounded time (`frames::Finish`). | `native/src/frames.rs` tests, `test/sidecar.test.mjs` |
| The published manifest lists the platform package of every platform the binaries workflow builds, at its own version. | `test/platform-packages.test.mjs` |
| `msg::PROTOCOL_VERSION` changes with any change to what the sidecars send each other; buyer and seller must agree. | review only |

## Traps

- Local macOS builds: if the linker fails on `arm64e.x1` in the macOS 27 SDK, build with `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk MACOSX_DEPLOYMENT_TARGET=14.0`.
- Tokio's stdin reader blocks runtime shutdown, so `main` exits the process explicitly, and an explicit exit drops whatever stdout has not written: `main` waits on `frames::Finish` first.
- The TLSNotary and mpz revisions must match each other; take them from one TLSNotary release's `Cargo.toml`, and keep `Cargo.lock`.
- TLS 1.2 only: an upstream that drops TLS 1.2 or AES-128-GCM can't be served this way.

**Ask first:** anything in `zk.rs` or `records.rs`; what the seller writes (`keyedRelayHead` in `packages/node`); what the buyer reveals (`keyedRevealRanges` and `keyedRequestBody` in the CLI); what the seller admits (`checkKeyedRequest`).

**Prove it:** `pnpm --filter @antseed/keyed-relay build:native`, `test:native`, `build` and `test` (the sidecar pair against a local TLS upstream), then `node --test apps/cli/dist/proxy/blind-relay.test.js` after a CLI build. The whole path with payments, without spend: `seller-blind-relay`, `seller-blind-relay-unrevealed-usage` and `stress-seller-blind-relay` against the local TLS upstream (command in `e2e/testbench/README.md`, Scenarios). Against a real upstream (it needs `--live` with a real key, so ask first): `pnpm testbench run seller-blind-relay --chain local --live --config <a seller config with a seller-blind service>`.
