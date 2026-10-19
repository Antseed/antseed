# @antseed/protocol

Owns the wire protocol: frames, message types, codecs, and the EIP-712 SpendingAuth and ReserveAuth typed data. Read `README.md` here for the module map.

## Boundaries

- Depends only on `ethers`. No Node-only APIs: browsers and the desktop renderer load it.
- Everything else depends on it. It depends on no other `@antseed/*` package.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| EIP-712 domain is `name: 'AntseedChannels'`, `version: '1'`, and every typehash matches the contract byte for byte. | `packages/node/tests/eip712-contract-compat.test.ts`, `src/signatures.test.ts` |
| A wire change stays readable by peers on the previous release. Add fields, never repurpose or remove them. | review only |

## Ask first

- Any change to a message type, a frame layout, a codec, or a signed struct.
- Any change to `signatures.ts`. It is security-critical, so the keys row always runs.

## Prove it

The verify-antseed skill decides what proves a change here. `pnpm --filter @antseed/protocol test` and `typecheck` always run.
