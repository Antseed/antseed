# 09 — Deposit Sweep Protocol

Decentralized gasless funding of a buyer's `AntseedDeposits` balance. The buyer
hot wallet does not need ETH for the relayed sweep. USDC arriving at the hot
wallet (QR deposits, onramp deliveries) is moved into the deposits contract by
**permissionless relayers** (sellers by default), compensated by a fixed USDC
fee taken from the swept amount. No centralized paymaster, bundler, or relayer
service is involved.

## On-chain component

`AntseedDepositRelay` (stateless periphery, swappable tier — holds no funds
between transactions, no owner, no tunable parameters):

```
sweepDeposit(
  address from, uint256 amount,
  uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes sig3009
)
```

1. Pulls `amount` USDC from `from` via EIP-3009 `receiveWithAuthorization`
   (`to` is pinned to the relay contract, so only the relay can redeem the
   authorization; the 3009 nonce makes it single-use).
2. Credits `amount - FEE` to the **buyer's** `AntseedDeposits` balance via
   `deposit(from, amount - FEE)` — the swept tokens move from the hot wallet
   through the relay into contract custody. Requires `amount > FEE`, and mirrors both Deposits
   guards with clear errors for simulating relayers: a first-time buyer's net
   must clear `MIN_BUYER_DEPOSIT`, and the credited balance must not exceed
   `getBuyerCreditLimit(from)`. Buyers should size sweeps to their remaining
   credit-limit headroom (the CLI clamps automatically).
3. Transfers the fixed `FEE` to `msg.sender`.

`FEE` is a `uint256 public immutable` constructor parameter (deployed at
50,000 base units = $0.05). **Single-signature consent:** signing an EIP-3009
authorization addressed to the relay contract is consent to its public,
immutable terms — there is no separate fee signature, and no governance that
could change the fee after a user signed. (A tunable cap was rejected:
relayers always claim the maximum, so a cap IS the fee.) Changing the fee
means deploying a new relay at a new address; outstanding authorizations to
the old address keep the old terms.

Any failure reverts the whole transaction: funds never leave the buyer wallet
on a failed sweep. Front-running is harmless by design — a front-runner can
only execute the identical sweep and claim the fee; the buyer outcome is
unchanged.

## Message Types (0xA0-0xAF)

| Hex  | Name         | Direction        | Purpose |
|------|--------------|------------------|---------|
| 0xA0 | SweepRequest | Buyer -> Relay-capable peers | Broadcast a signed sweep for relayers to submit |
| 0xA1 | SweepReceipt | Relayer -> Buyer | Optional progress report, correlated by the 3009 nonce |

Payloads are UTF-8 JSON (like the payment protocol), capped at **8 KiB**.
uint256 values are decimal strings; addresses, bytes32 values, and signatures
are 0x-prefixed hex strings. Receivers MUST validate every field (shape,
length, version) — payloads are untrusted peer input.

### SweepRequest (0xA0)

| Field        | Type   | Description |
|--------------|--------|-------------|
| version      | number | Always `1` |
| evmChainId   | number | EVM chain the sweep targets (e.g. 8453) |
| relayAddress | string | `AntseedDepositRelay` the buyer signed against |
| from         | string | Buyer hot wallet (source and credited account) |
| amount       | string | Total USDC pulled via EIP-3009, base units (uint256 decimal) |
| validAfter   | number | EIP-3009 window start, unix seconds (exclusive) |
| validBefore  | number | EIP-3009 window end, unix seconds (exclusive) |
| nonce        | string | EIP-3009 nonce (bytes32 hex); correlation key |
| sig3009      | string | 65-byte buyer signature over `ReceiveWithAuthorization` |

### SweepReceipt (0xA1)

| Field     | Type   | Description |
|-----------|--------|-------------|
| version   | number | Always `1` |
| authNonce | string | The SweepRequest's 3009 nonce |
| status    | string | `submitted` \| `confirmed` \| `rejected` |
| txHash    | string | Optional transaction hash (bytes32 hex) |
| reason    | string | Optional human-readable rejection reason (≤256 chars) |

Receipts are informational only. The buyer's source of truth is its on-chain
Deposits balance; there is no response requirement, and buyers MUST tolerate
receiving no receipts at all.

## Typed data

The buyer signs exactly one thing — the EIP-3009 authorization on the USDC
domain (verified against the deployed token; Base mainnet is
`{name: "USD Coin", version: "2"}`):

```
ReceiveWithAuthorization(address from,address to,uint256 value,
  uint256 validAfter,uint256 validBefore,bytes32 nonce)
```

`to` MUST be the relay contract address. Because the authorization binds
from/to/amount/validity/nonce and the relay's terms (FEE) are immutable,
addressing it to the relay is complete consent — no second signature exists.

## Relayer behavior (sellers, opt-out)

Sellers that support deposit sweeps MUST announce the peer metadata capability
`payments.relays-sweeps.v1`. Sellers set this capability only when the relayer
is enabled and the configured chain has a deposit relay address. Buyers MUST
target sweep broadcasts only to peers that announce this capability.

On `SweepRequest`, in order:

1. Drop unless `evmChainId` and `relayAddress` match the relayer's **own**
   configuration — never submit to a peer-supplied contract address.
2. Drop already-seen nonces (bounded LRU) and enforce per-peer rate limits
   (default 6/min) and a global in-flight cap (default 2).
3. Verify the 3009 signature locally and check the validity window.
4. Simulate the call (`eth_estimateGas`); reject on any revert.
5. Accept when `FEE - estimatedGasCostUsdc >= relayer.minProfitBaseUnits`
   (default `"0"`; may be negative to relay at a loss, e.g. local testing
   where anvil's gas price dwarfs the fee).
6. Submit with the seller wallet; report `submitted` → `confirmed`/`rejected`.

Losing the submission race (3009 nonce already consumed by another relayer) is
normal: log and move on. The relayer is enabled by default for sellers and
disabled with `relayer.enabled: false`.

## Buyer dispatch strategy (sequential offers)

Broadcasting one sweep to every relay-capable peer simultaneously makes
relayers race the same 3009 nonce: exactly one submission lands and every
other relayer burns gas on a reverted transaction. Buyers SHOULD instead offer
a sweep to candidate relayers **one at a time**:

1. Shuffle the connected relay-capable peers so no relayer always gets first
   refusal.
2. Send the `SweepRequest` to one peer and wait for its `SweepReceipt`
   (recommended ~10s): `submitted`/`confirmed` ends the round; `rejected` or
   silence passes the offer to the next candidate.
3. Stop offering when the authorization is within ~30s of `validBefore`
   (mirroring the relayer's own expiry guard).

This is purely a buyer-side dispatch policy — the wire format is unchanged and
relayers need no upgrade. Receipts remain informational: even after a relayer
accepts, the buyer's source of truth is its on-chain Deposits balance, and the
per-relayer simulation still protects an accepting relayer that raced an
out-of-band submission of the same authorization.

## Privacy note

Broadcasting a sweep reveals the buyer address and amount to connected peers.
The same data becomes public on-chain when the sweep lands; no additional
mitigation is applied in v1.

## Threat notes

A funded buyer can grief relayers by broadcasting valid authorizations and then
front-running with `cancelAuthorization`, causing relayer submissions to revert
after gas is spent. The attacker pays comparable gas to do this, and relayer
exposure is bounded by the per-peer rate limit (default 6/min), the global
in-flight cap (default 2), local signature verification, and simulation before
submission.
