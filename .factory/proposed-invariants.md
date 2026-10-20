# Proposed `## Invariants` section for the repo's CLAUDE.md

A proposal, not a repo change: nothing here is committed to `main` or to the sandbox branch. Paste the section below into `CLAUDE.md` once a human agrees with it. Every invariant names what enforces it today; "nothing" means a reviewer is the only guard, and that row is a candidate for the `correct` skill (make it a test, type or lint).

Grounded on origin/main `c78e8bc54` (2026-10-18) and the verify-antseed skill on `origin/codex/sandbox-stack` `b04d74922`.

---

## Invariants

Break one of these and the change is wrong, however green the build is. Changes to the paths in the security-critical list (the "Security-critical changes" list in the verify-antseed skill) always run the verify-antseed "keys, signing or spend caps" row.

| # | Invariant | Where it lives | Enforced by |
| --- | --- | --- | --- |
| 1 | USDC amounts are `bigint` base units (6 decimals) end to end. Never a JS `number` or float; format and parse only through the shared helpers, and `parseUsdc(formatUsdc(x)) === x` for every `x`, negative included. | `packages/buyer-core/src/usdc-utils.ts` | `packages/buyer-core/src/pricing.test.ts` (positive values only today) |
| 2 | The buyer never signs more than `verifiedCost + maxPerRequestUsdc` (overdraft cap) and never reserves more than `maxReserveAmountUsdc`. | `packages/buyer-core/src/buyer-payment-manager.ts:97` | `packages/node/tests/buyer-payment-manager.test.ts` |
| 3 | A channel's signed SpendingAuth `cumulativeAmount` never decreases, and after a catch-up the buyer signs the seller's required amount, not more. | `packages/buyer-core`, `packages/node/src/seller-request-handler.ts` | `packages/node/tests/buyer-payment-*.test.ts`; sandbox `issue-1200-spendingauth-catchup` |
| 4 | On-chain settlement equals what the buyer signed and never exceeds it; settle-on-disconnect charges exactly the delivered work. | `packages/contracts/payments/AntseedChannels.sol`, `AntseedDeposits.sol` | `forge test`; sandbox `payment-flow` |
| 5 | EIP-712 domain is `name: 'AntseedChannels'`, `version: '1'`; SpendingAuth and ReserveAuth typehashes match the contract byte for byte. | `packages/protocol/src/signatures.ts:463` | `packages/node/tests/eip712-contract-compat.test.ts`, `packages/protocol/src/signatures.test.ts` |
| 6 | The Channels contract holds no USDC; Deposits and Staking hold funds. Channels stays swappable by re-pointing the stable contracts. | `packages/contracts/payments/` | nothing automated (review only) |
| 7 | The buyer never needs gas: every on-chain action is seller-initiated or permissionless. | node payments, contracts | nothing automated (review only) |
| 8 | Identity keys are never logged, printed, sent to a peer or written outside the identity store. | `packages/node/src/p2p/identity.ts`, `apps/desktop/src/main/identity.ts` | `packages/node/tests/identity.test.ts` (persistence only); desktop identity has no test |
| 9 | SQLite schema changes are new numbered migrations; an existing migration file is never edited. | `packages/node/src/storage/migrations/` | nothing automated (CLAUDE.md rule) |
| 10 | Subscription-based provider plugins are for testing only; no code or doc presents them as a resale path. | `plugins/provider-claude-*` | nothing automated (CLAUDE.md rule) |
| 11 | Agents and tests never touch `~/.antseed`, the OS keychain or port 8377, and sandbox runs use `--chain local` unless a human said yes to `--live`, `--real-funds` or mainnet. | `e2e/sandbox/` (sandbox stack) | sandbox CLI refusals; the factory's session settings |
| 12 | A bug-fix PR with a cheap unit-test repro is two commits: the failing test alone (red on `main`), then the fix (green). Otherwise the red is a sandbox scenario. | every fix PR | the verify-antseed skill's `prove.sh`; nothing in CI |

Stale fact found while grounding this: CLAUDE.md's "Smart Contracts" tree lists `packages/contracts/AntseedChannels.sol` and siblings at the package root; on `main` they live in `packages/contracts/payments/`, `staking/`, `emissions/` and so on.
