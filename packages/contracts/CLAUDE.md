# packages/contracts

Owns the on-chain protocol: deposits, channels, staking, emissions, rewards. Read `README.md` here for the contract map and how the contracts call each other.

## Boundaries

- Contracts reference each other by address set at deployment. No inheritance, only interface calls through `interfaces/`.
- `AntseedDeposits` and `AntseedStaking` hold funds and rarely change. `AntseedChannels` holds no USDC and stays swappable by re-pointing the stable contracts.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| On-chain settlement equals what the buyer signed and never exceeds it. Settle-on-disconnect charges exactly the delivered work. | `forge test`, sandbox `payment-flow` |
| Channels holds no USDC. | review only |
| The buyer never needs gas: every on-chain action is seller-initiated or permissionless. | review only |
| EIP-712 domain and typehashes match `packages/protocol/src/signatures.ts`. | `packages/node/tests/eip712-contract-compat.test.ts` |

## Ask first

- Every change here. Deployed contracts are a one-way door.

## Prove it

The verify-antseed skill decides what proves a change here. `forge test` always runs.
