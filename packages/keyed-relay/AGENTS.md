# @antseed/keyed-relay

The seller-keyed blind relay. A seller serves a `seller-blind` service with its own upstream key: the buyer runs TLS to the upstream through the seller, proves the session keys in zero knowledge, and the seller writes the request head with its key as the session's first record without being able to read the session. The buyer never sees the key. Before the seller forwards the request, the buyer reveals its headers and the body's last fields for the seller's check; after the answer, only the status line and the usage the seller bills by.

The cryptography is a Rust sidecar in `native/` built on TLSNotary's building blocks (the ZK VM, the TLS 1.2 PRF circuit, the AES circuit) at the revisions in `native/Cargo.toml`. `src/index.ts` spawns it and speaks its framing; `@antseed/node` (seller, `SellerBlindRelay`) and the CLI (buyer, `apps/cli/src/proxy/keyed-relay-client.ts`) use it.

## Inside

- `native/src/zk.rs` — the key proof (PRF and both Finished checks) and the keystream it reveals: the seller record's keystream and tag mask, the client GHASH key, the request ranges the buyer reveals for the seller's check, and at the end the response ranges it reveals for billing.
- `native/src/seller.rs`, `native/src/buyer.rs` — the two roles; `records.rs` the TLS 1.2 record layer and the seller's record; `ranges.rs` maps stream ranges onto records; `frames.rs` the stdin/stdout framing; `session.rs` the buyer ↔ seller mux.
- The request check itself is Node's: `checkKeyedRequest` in `packages/node/src/keyed-relay-request.ts`, on the tail `keyedRequestTailFields` (`packages/protocol`) defines and the CLI's `keyedRequestBody` writes.
- `scripts/platform-package.mjs` and `.github/workflows/keyed-relay-binaries.yml` — the per-platform npm packages the resolver finds.

| Rule | Enforced by |
| --- | --- |
| The seller writes its record only after the certificate, the server signature, AES-128-GCM, ALPN `http/1.1` and the key proof all check out. | `test/sidecar.test.mjs` (certificate), review |
| The buyer never receives the seller's record; nothing secret crosses the relay in plaintext. | `test/sidecar.test.mjs` |
| Every value the seller gets from the proof is decoded from the ZK VM, never sent by the buyer: a buyer-chosen keystream would let it flip the seller's head. | review only |
| One request per session: the head ends with `Connection: close` and the credential is never its last header. | `packages/node/tests/keyed-relay.test.ts` |
| The seller forwards nothing of the buyer's request until Node admits it, then only that request's bytes (alerts after it, no more application data). A refused request never reaches the upstream. | `test/sidecar.test.mjs`, `apps/cli/src/proxy/blind-relay.test.ts` |
| The seller admits a request only on its full header block (allow-listed headers, a true `Content-Length`) and the canonical last fields, byte for byte. | `packages/node/tests/keyed-relay.test.ts` |
| The seller bills the revealed usage only from a tail that runs to the end of the response and starts at a `data:` event or the `"usage":` key. | `packages/node/tests/keyed-relay.test.ts` |
| The seller sidecar hands Node each revealed range whole, joined across the TLS records it spans: an upstream ends a chunked body in a record of its own, and Node bills and checks only a range that runs to the end. | `native/src/ranges.rs` tests, `test/sidecar.test.mjs` |
| `msg::PROTOCOL_VERSION` changes with any change to what the sidecars send each other; buyer and seller must agree. | review only |

## Traps

- Local macOS builds: if the linker fails on `arm64e.x1` in the macOS 27 SDK, build with `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk MACOSX_DEPLOYMENT_TARGET=14.0`.
- Tokio's stdin reader blocks runtime shutdown, so `main` exits the process explicitly.
- The TLSNotary and mpz revisions must match each other; take them from one TLSNotary release's `Cargo.toml`, and keep `Cargo.lock`.
- TLS 1.2 only: an upstream that drops TLS 1.2 or AES-128-GCM can't be served this way.

**Ask first:** anything in `zk.rs` or `records.rs`; what the seller writes (`keyedRelayHead` in `packages/node`); what the buyer reveals (`keyedRevealRanges` and `keyedRequestBody` in the CLI); what the seller admits (`checkKeyedRequest`).

**Prove it:** `pnpm --filter @antseed/keyed-relay build:native`, `test:native`, `build` and `test` (the sidecar pair against a local TLS upstream), then `node --test apps/cli/dist/proxy/blind-relay.test.js` after a CLI build. The whole path with payments, against a real upstream (it needs `--live`, so ask first): `pnpm testbench run seller-blind-relay --chain local --live --config <a seller config with a seller-blind service>`.
