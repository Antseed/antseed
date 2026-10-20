# AntSeed monorepo

AntSeed is a peer-to-peer AI services network. Providers sell differentiated AI services, and buyers route each request to the best peer and pay per request in USDC on Base.

## Working rules

- **Never commit or push unless asked.** Make the edit, run the checks, then stop and report. Commit or push only when the user says so ("commit", "push", "open a PR", or a commit or PR skill), even if earlier turns committed. The user batches edits into one reviewed commit.
- **Verify in the sandbox; ask before spending.** After a change to payments, routing, discovery, the buyer proxy, plugins, `packages/node` or the desktop, run `pnpm sandbox` (`e2e/sandbox/README.md`).
  - verify-antseed maps a changed path to what must run and what evidence to keep. sandbox-test is the how-to.
  - No ask needed for builds, tests, scenarios, `--chain local` or fork runs, and desktop QA.
  - Each `--live`, `--real-funds` or mainnet run needs a yes. For a buyer, proxy or routing change, propose `pnpm sandbox run mainnet-smoke --chain mainnet --real-funds` as a separate step.
  - Tear down only with `pnpm sandbox down`. Never weaken a check or turn a `KNOWN` result into a pass.
- **Changelog.** A PR with a user-facing change (package, CLI, desktop, protocol, config or docs behavior) updates `CHANGELOG.md`. A PR without one says so in its description.
- **Facts about AntSeed** in docs or marketing (pricing, payment flow, CLI behavior, what is free) come only from this repo or antseed.com. Never use general knowledge, a web search or a doc's silence. If you can't verify a fact, say so.
- **Not resale, not crypto-only.** Providers must add value: TEE, skills, agents, fine-tunes or a managed product. `provider-claude-code` and `provider-claude-oauth` are for testing only. Buyers can fund by card checkout in the desktop (region-gated), an exchange withdrawal or another wallet (`apps/website/docs/gateway/funding.md`). Never describe AntSeed as crypto-only, or as needing crypto already.

## Design principles

AntSeed is a credibly neutral marketplace: it carries the standards buyers and sellers already use and makes none of its own.

- **Standards, intact.** Buyers call the standard APIs: Anthropic Messages, OpenAI Chat Completions, Responses and Images, IRP and the vendors' video APIs. A tool built for one works unchanged against the buyer proxy. A request passes natively when the seller speaks its protocol, and is translated only when the seller doesn't. AntSeed's own data goes in `x-antseed-*` headers and the P2P frame. A new upstream is a protocol id for its existing standard, never an AntSeed format.
- **Neutral.** No seller, router, model or protocol is favored in code. Routing ranks by declared factors, and a router is a service the buyer picks.
- **Extend at the edges.** An upstream is a plugin, and a reward rule is a policy contract. The core gains interfaces, not special cases.
- **Thin hosts.** The desktop and the gateway run the CLI buyer and call its `/_antseed/*` API. A host change covers that whole host. Buyer behavior goes in the CLI, not in a host, and not in the core because a host needs it.
- **Stable money, swappable logic.** Whatever holds funds changes rarely. The logic around it sits behind interfaces.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| USDC is integer base units (6 decimals). It is `bigint` through `packages/buyer-core/src/usdc-utils.ts`; only the gateway (`money.ts`) uses safe-integer `number`. Never a float. | `packages/buyer-core/src/pricing.test.ts` (positive values only) |
| Identity keys are never logged, printed, sent to a peer or written outside the identity store. | `packages/node/tests/identity.test.ts` (persistence only); desktop identity has no test |
| Agents and tests never touch `~/.antseed`, the keychain or port 8377. | sandbox CLI refusals; factory session settings |
| A bug fix with a cheap unit-test repro is two commits: the failing test, then the fix. | verify-antseed `prove.sh` |
| A change on verify-antseed's high blast radius paths runs its keys, signing or spend caps row. | verify-antseed |

## Map

`guide` marks a `CLAUDE.md` with what is specific to that area. Read it before you change the area. A package's own `test` and `typecheck` always run, unless its guide names other commands. verify-antseed decides what else proves the change.

| Path | What |
| --- | --- |
| `packages/protocol` (guide) | Wire format, codecs, EIP-712 signatures |
| `packages/api-adapter` (guide) | Translation between API standards |
| `packages/buyer-core` (guide) | The buyer. Environment-free, so the CLI and the browser run the same code |
| `packages/node` (guide) | Runtime: P2P, discovery, metering, sqlite, plugin host |
| `packages/provider-core` | Building blocks for provider plugins (`BaseProvider`, `HttpRelay`) |
| `packages/router-core` (guide) | Peer scoring and the routing-service client |
| `packages/web-sdk` (guide) | Browser buyer |
| `packages/contracts` (guide) | Solidity contracts (Foundry). Map in its `README.md` |
| `packages/antseed-verifier`, `connected-apps`, `ant-agent`, `ui`, `wallet-config` | Seller attestation; local AI tool setup; knowledge agents; shared UI; wallet constants |
| `plugins/` (guide) | One plugin per upstream |
| `apps/cli` (guide), `apps/cli/src/gateway` (guide) | The `antseed` command, the buyer proxy, the gateway |
| `apps/desktop` (guide) | Electron app |
| `apps/gateway-console`, `payments`, `ants`, `relay`, `network-stats`, `website`, `diem-staking`, `download-proxy` | Web apps and services, each with a `package.json` description |
| `e2e/`, `docs/protocol/` | Sandbox and scenarios; protocol spec and plugin templates |

Dependency direction: `protocol` and `api-adapter` ← `buyer-core` ← `node` ← `provider-core` and `router-core` ← `plugins` ← `cli` ← `desktop`. `web-sdk` uses `buyer-core` and `protocol`. Cross-package references use `workspace:*`.

## Payment flow

1. The buyer deposits USDC into `AntseedDeposits`.
2. The buyer signs a ReserveAuth off-chain, and the seller calls `reserve()` on `AntseedChannels`.
3. For each request, the buyer signs a SpendingAuth with a growing `cumulativeAmount`.
4. The seller calls `settle()` or `close()` with the latest one.
5. If the seller disappears, the buyer calls `requestClose()`, then `withdraw()` after 15 minutes.

## Commands and toolchain

- **Commands.** `pnpm install`, then `pnpm run build`, `test`, `typecheck` and `clean`. `build` runs the tiers in `package.json` in dependency order.
- **Toolchain.** Node 24 (`.nvmrc`, Volta), TypeScript strict, ES modules and pnpm workspaces. Libraries build with tsc, and web apps and the renderer with Vite. Tests use vitest, except `apps/cli` and the desktop main process, which use `node --test`.
- **Native modules.** better-sqlite3 and node-datachannel, in `packages/node`. The desktop rebuilds them for Electron's Node.
- **Contracts.** `cd packages/contracts && forge build && forge test`.
- **Nix.** `nix develop` gives a dev shell, and `nix build .#` builds the CLI. Update the prebuild hashes in `flake.nix` when those native dependencies change in `pnpm-lock.yaml`.
