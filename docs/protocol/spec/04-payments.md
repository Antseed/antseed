# 04 - Payments: Streaming SpendingAuth

This document specifies the payment protocol for the Antseed P2P AI compute network. Payments use USDC on Base with two EIP-712 signed messages: **ReserveAuth** (session budget) and **SpendingAuth** (cumulative per-request authorization). AntseedChannels orchestrates the lifecycle but holds no USDC — all funds stay in AntseedDeposits.

## 1. Session Lifecycle (Reserve → Serve → Settle/Close)

```
BUYER                              SELLER                           ON-CHAIN
  │                                  │                                │
  │ ─ ReserveAuth ─────────────────► │                                │
  │   {channelId, maxAmount,         │                                │
  │    deadline}                      │ ── reserve(buyerSig) ─────────►│
  │                                  │    Deposits.lockForChannel()   │ ← USDC locked
  │                                  │                                │
  │ ◄── AuthAck ─────────────────── │                                │
  │                                  │                                │
  │ ══ SERVE ═══════════════════════ │                                │
  │   requests flow                  │   cumulativeAmount increases   │
  │   ◄── SellerReceipt (per req) ── │   running total + hash         │
  │   ── SpendingAuth ────────────► │   buyer signs cumulative auth  │
  │         ... N requests           │                                │
  │                                  │                                │
  │  === SETTLE (mid-session) ======  │                                │
  │                                  │ ── settle(SpendingAuth) ──────►│ ← charges cumulative
  │                                  │    Deposits.chargeAndCredit    │   session stays open
  │                                  │    EarningsToSeller()          │
  │                                  │                                │
  │  === CLOSE (final) ============  │                                │
  │                                  │ ── close(SpendingAuth) ───────►│ ← charges final amount
  │                                  │    releases remaining lock     │   session finalized
  │                                  │                                │
  │  === TIMEOUT (seller gone) ====  │                                │
  │   buyer ── requestClose() ─────────────────────────────────────── ►│ ← starts grace period
  │   (15min grace)                  │                                │
  │   buyer ── withdraw() ─────────────────────────────────────────── ►│ ← funds returned
```

### Reserve

The buyer signs an EIP-712 `ReserveAuth` (channelId, maxAmount, deadline) and sends it to the seller over P2P. The seller calls `reserve()` on-chain, which verifies the buyer's signature and calls `Deposits.lockForChannel()` to lock the buyer's USDC. The channelId is `keccak256(abi.encode(buyer, seller, salt))`.

### Serve

During the session, the seller sends a `SellerReceipt` after each request. The buyer signs a `SpendingAuth` with the new cumulative amount and metadata hash. These form the authorization trail.

When the session budget is nearly exhausted, the seller settles (calls `close()`), returns HTTP 402, and the buyer initiates a new session negotiation with a fresh ReserveAuth.

### Settle / Close

The seller calls `settle()` with the latest SpendingAuth to charge the cumulative amount while keeping the session open. To finalize, the seller calls `close()`, which charges the final amount and releases remaining locked funds to the buyer.

### Timeout

If the seller disappears, the buyer (or their deposits operator) calls `requestClose()` anytime while the channel is active. After a 15-minute grace period, the buyer calls `withdraw()` to release remaining locked funds back to their deposit.

### Cooperative close (buyer-requested)

Close is normally seller-initiated. A buyer that wants its reserve back **now** —
without waiting out the 15-minute timeout grace period — asks the seller to
close instead, over `CloseChannelRequest` / `CloseChannelResult` (§11).

```
BUYER                              SELLER                           ON-CHAIN
  │ ─ CloseChannelRequest ────────► │                                │
  │   {channelId, [SpendingAuth]}   │  no request in flight?         │
  │                                  │  no unsigned spend?            │
  │                                  │  amount = max(own, buyer's)    │
  │                                  │ ── close(SpendingAuth) ───────►│
  │ ◄── CloseChannelResult ───────── │                                │
  │   {status: closed, txHash}       │                                │
```

The buyer MAY attach its latest SpendingAuth. Attaching costs it nothing — the
cumulative is unchanged, so it authorizes no more than the seller could already
claim — but it lets a seller that never received the last auth (lost frame,
crash before persist) still close at the full amount owed. The seller settles at
`max(own last-accepted, buyer-supplied)`, so neither party can use this path to
settle below what is actually owed. A supplied auth must recover to the on-chain
channel buyer and its `metadataHash` must match its `metadata`, or the request is
rejected as `invalid_auth`.

The seller agrees only when it is **not mid-accumulation** with that buyer:

- No billable request is in flight. The seller holds the channel open for the
  whole billable span — provider call, spend recording, and the follow-up
  NeedAuth — so a close cannot land between serving a request and claiming its
  cost. Otherwise: `busy`.
- No served work is unsigned. If `spent` exceeds the highest signed cumulative,
  the seller waits briefly for a catch-up auth already on the wire; failing
  that it emits a `NeedAuth` for the outstanding amount and rejects with
  `pending_auth` plus `requiredCumulativeAmount`. The buyer signs and retries.

Rejections are normal outcomes, not errors — the channel is left untouched and
the buyer can retry or fall back to `requestClose()`. When neither side holds
a usable auth the seller closes at the current on-chain `settled` amount with an
empty signature, which the contract accepts without signature verification
(`finalAmount == settled`) and which claims no unproven spend.

Sellers advertise support with the `payments.cooperative-close.v1` capability in
discovery metadata and in the connection handshake. A seller predating this
protocol drops the unrecognized `0x59` frame silently, so buyers MUST check the
capability before sending and fail fast rather than waiting out the response
timeout. The check reads the peer's **discovery metadata**; the connection
handshake's remote-capability set is only populated for inbound connections and
so is empty on the buyer's own outbound connection. A buyer that has no
capability data for a peer at all SHOULD attempt the close anyway — absence of
data is not evidence of non-support.

## 2. EIP-712 Signed Messages

EIP-712 domain for both message types:

```
name:               "AntseedChannels"
version:            "7"
chainId:            <deployment chain>
verifyingContract:  <channels contract address>
```

### ReserveAuth

```
ReserveAuth(
  bytes32 channelId,
  uint128 maxAmount,
  uint256 deadline
)
```

| Field | Description |
|---|---|
| `channelId` | `keccak256(abi.encode(buyer, seller, salt))` — unique per session |
| `maxAmount` | Maximum USDC (6 decimals) the seller may lock from the buyer's deposit |
| `deadline` | Unix timestamp after which this authorization and the session expire |

The buyer signs this off-chain. The seller submits it to `reserve()` along with buyer address, salt, maxAmount, and deadline.

### SpendingAuth

```
SpendingAuth(
  bytes32 channelId,
  uint256 cumulativeAmount,
  bytes32 metadataHash
)
```

| Field | Description |
|---|---|
| `channelId` | Same channel identifier as the ReserveAuth |
| `cumulativeAmount` | Total USDC authorized so far (monotonically increasing across requests) |
| `metadataHash` | Hash of request metadata (input/output tokens, model identifier, etc.) |

The buyer signs a new SpendingAuth after each request. The seller accumulates these and submits the latest to `settle()` or `close()`. Single signature per action — no dual signatures required.

## 3. Session Budget and Budget Exhaustion

The `maxAmount` in the ReserveAuth caps total USDC the seller can charge in a session. The buyer's SpendingAuth `cumulativeAmount` must not exceed this cap.

When the budget is nearly exhausted, the seller calls `close()` with the final SpendingAuth, returns HTTP 402 to the buyer, and the buyer initiates a new session negotiation with a fresh ReserveAuth and salt.

## 4. Per-Agent Stats (AntseedStats)

Channel metrics are tracked per ERC-8004 agentId in the AntseedStats contract. Stats are updated by AntseedChannels during `settle()` and `close()`:

- `channelCount` — number of completed channels
- `totalVolumeUsdc` — cumulative USDC volume
- `totalRequests` — cumulative request count

Stats are factual counters with no reputation scoring logic. They feed into emissions and staking calculations.

## 5. Anti-Gaming Defences

| Layer | Mechanism | Default |
|---|---|---|
| Minimum deposit | Buyers must deposit at least N USDC to participate | 10 USDC |
| Seller eligibility | Checked through the registry's active staking contract | Legacy USDC fallback while enabled; ANTS pool rules after cutover |
| Budget binding | ReserveAuth binds maxAmount and deadline to buyer signature | Per-session |
| Cumulative auth | SpendingAuth cumulativeAmount is monotonically increasing | Per-request |
| Gasless buyer | Buyer never submits transactions — cannot be griefed for gas | Always |

## 6. Staking

Before the epoch-22 cutover, `AntseedStaking` uses USDC stake bound to an ERC-8004
agent ID, with a 10 USDC minimum. After cutover, `AntseedSellerRegistry` supplies
seller eligibility, with legacy USDC stake accepted while its fallback is enabled.
New reward points additionally require sufficient ANTS pool power. See
[staking and exit terms](../../../apps/website/docs/protocol/recognized-usage.md)
and [legacy USDC staking](../../../apps/website/docs/protocol/legacy-emissions.md#legacy-usdc-staking).

## 7. Stats and Identity

### AntseedStats (on-chain metrics)

Factual per-agent session metrics updated by AntseedChannels during settlement. No reputation scoring — pure counters.

### ERC-8004 Identity and Feedback

Identity uses the deployed ERC-8004 IdentityRegistry (Base: `0x8004A169...`). Feedback uses the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`). There is no custom AntseedIdentity contract.

### MockERC8004Registry

For local testing only. Simulates the ERC-8004 registry interface so contracts can be tested without a mainnet dependency.

## 8. Emission Distribution (ANTS Token)

### ANTS Token

ERC-20 on Base with a 1.04 billion ANTS maximum supply and zero initial supply.
Scheduled emissions fund participant rewards and protocol allocations. M001
pre-mints the remaining pre-effective-epoch schedule into the legacy escrow;
that reserve is not a new user reward or freely claimable balance.

**Transfer-restricted phase:** Ordinary transfers are disabled; minting and transfers by whitelisted senders are allowed. Owner calls `enableTransfers()` as a separate, irreversible action. M001 does not enable trading.

After M001 phase 1 on September 6, 2026, `ANTSToken.registry()` points to
`AntseedEmissionsGate` (`0xE60a31E6CD2F8455503cA0B3f6545Dd3DDF543BD`). The gate
controls minting; legacy V2's unchanged mint calls now transfer from
`AntseedLegacyEmissionsEscrow` (`0x4d0fC3C0BBb5233Af6c4Ce33223e5330c34db9ab`).

### Recognized Usage (From Epoch 22)

**Protocol start: September 10, 2026 at 09:54:21 UTC (epoch 22).**

The standard reward model combines eligible usage with ANTS seller-pool power.
`AntseedRegistry.staking()` resolves to `AntseedSellerRegistry`
(`0x99c533BCc6Ca646E543dbA835Fdbb9C2ee02Cb60`) and `emissions()` to
`AntseedUsageAccounting` (`0xAdd2D85316153D7bfaF7921EE9Bf1Bb6c7A1cBc9`)
after activation. Buyer USDC deposits, channel signatures, and settlement are unchanged.

Allocation ceilings are 40% seller-pool rewards, 20% usage rewards, 15% team,
15% reserve, and 10% verification. Pool and usage payouts follow dynamic
allocation and eligibility rules rather than paying their ceiling unconditionally.
The gate uses weekly epochs and a 104-epoch halving interval.

For epoch 22, the dynamic stake target is 400 million active ANTS and the usage
target is 1 million USDC of recognized volume per epoch. These are curve
reference points, not maximum-share thresholds: reaching them produces a 21%
staker share and 7.5% each for buyer and seller/operator usage. See
[stake and usage targets](../../../apps/website/docs/protocol/recognized-usage.md#stake-and-usage-targets)
for the formula, post-policy volume measure, and emission-scaled stake target.

Unallocated seller-pool and usage budgets are settled through the gate: burns
take priority up to a shared cap of 30% of the epoch's scheduled emissions, with
excess sent to the emissions reserve. This does not sweep earned but unclaimed
rewards. Burns require remainder settlement and mint ANTS to the dead address;
they do not reduce ERC-20 `totalSupply()`. See the
[burn and reserve rule](../../../apps/website/docs/protocol/recognized-usage.md#unallocated-emissions-and-burns)
for the calculation and the separate early-withdrawal burn.

Accounting tracks raw and pool-weighted points and applies sequential policies.
The public policy returns remain `(sellerPoints, buyerPoints)`. A zeroed side
cannot be restored and evaluation stops when both sides are zero. Historical
wash flags zero future records involving the seller, not previously credited
points, and do not prevent starter-position initialization or USDC settlement.

See [Reward Policies](../../../apps/website/docs/protocol/reward-policies.md)
for modifier composition, failure handling, and the distinction
between proof verification and canonical block authentication.

Locked ANTS positions are lANTS NFTs. Power activates in the next epoch. For a
contract seller, an authorized operator may call `initPosition(seller)`; the
caller owns the resulting position and its rewards/withdrawal rights.

See [Recognized Usage and ANTS Rewards](../../../apps/website/docs/protocol/recognized-usage.md)
for the full specification guide and address inventory. Activation is an
explicit registry-pointer operation; operational sequencing remains in the M001 runbook.

### Pre-Migration Emissions

**Looking for legacy emissions or historical claims?** See
[Legacy emissions and claims](../../../apps/website/docs/protocol/legacy-emissions.md).
The pre-migration V2 configuration is **65% sellers, 5% buyers, 15% reserve,
15% team**, with per-epoch snapshots governing historical rewards. Legacy V2
continues paying historical claims and owner-triggered team/reserve flushes
from the pre-minted escrow after migration.

## 9. Contract Architecture

```
ANTSToken                     ── mint authority is AntseedEmissionsGate
AntseedDeposits                ── holds buyer USDC deposits and seller payouts
AntseedChannels                ── signed payment channels, holds no USDC
AntseedSellerRegistry          ── ERC-8004 seller eligibility
AntseedSellerPools             ── locked ANTS positions and pool power
AntseedUsageAccounting         ── recognized usage and pool-weighted points
AntseedPointsPolicyRegistry    ── sequential points transformations
AntseedWashTradingRegistry     ── authenticated historical seller proofs
AntseedWashTradingPointsPolicy ── zeros future points for flagged sellers
AntseedSellerPoolsRewards      ── staker rewards
AntseedUsageRewards            ── buyer and seller/operator usage rewards
AntseedPositionInit            ── starter-position faucet
AntseedEmissionsGate           ── emission schedule and allocations
AntseedLegacyEmissionsEscrow   ── funds pre-migration claims and flushes
AntseedStats                   ── factual per-agent session metrics
```

Contracts reference each other by address (set at deployment, updateable by owner). No inheritance between contracts — only interface calls.

**Interaction flow:**
- `AntseedChannels` calls `AntseedDeposits.lockForChannel()` on reserve
- `AntseedChannels` calls `AntseedDeposits.chargeAndCreditPayouts()` on settle/close
- `AntseedChannels` calls `AntseedStats.updateStats()` on settle/close
- `AntseedChannels` calls `AntseedEmissionsV2.accrueSellerPoints()` / `accrueBuyerPoints()` on settle/close
- `AntseedChannels` reads from `AntseedStaking` (seller stake verification)
- `AntseedEmissionsV2` calls `ANTSToken.mint()` on claim

## 11. P2P Messages

Payment messages occupy `0x50-0x5F`. Payloads are UTF-8 JSON capped at 64 KiB;
uint256 values are decimal strings, and receivers MUST validate every field —
payloads are untrusted peer input.

| Type | Name | Direction | Description |
|---|---|---|---|
| 0x50 | `SpendingAuth` | Buyer → Seller | EIP-712 signed cumulative spending authorization (carries the opening ReserveAuth on the first send) |
| 0x51 | `AuthAck` | Seller → Buyer | Reservation confirmed |
| 0x52 | `FreeUsageOpen` | Buyer → Seller | Open a zero-price usage channel |
| 0x53 | `FreeUsageAuth` | Buyer → Seller | Signed cumulative zero-price usage record |
| 0x54 | `FreeUsageAck` | Seller → Buyer | Zero-price open/record accepted |
| 0x55 | `NeedFreeUsageAuth` | Seller → Buyer | Request a zero-price usage signature |
| 0x56 | `PaymentRequired` | Seller → Buyer | Payment terms accompanying an HTTP 402 |
| 0x58 | `NeedAuth` | Seller → Buyer | Per-request cost report + required cumulative |
| 0x59 | `CloseChannelRequest` | Buyer → Seller | Ask the seller to close the channel now (§1) |
| 0x5A | `CloseChannelResult` | Seller → Buyer | Close verdict: `closed` + txHash, or `rejected` + code |

`CloseChannelResult` rejection codes: `busy`, `pending_auth`, `no_channel`,
`invalid_auth`, `close_failed`, `unsupported`.

## 12. Session Persistence

Session state is persisted to SQLite in the node SDK. Schema:

- `sessions` table: channel_id, peer_id, role, EVM addresses, salt, max_amount, deadline, cumulative_amount, request_count, timestamps, status
- `receipts` table: channel_id, cumulative_amount, request_count, metadata_hash, seller_sig, buyer_spending_auth_sig, timestamp

## 13. Supported Chains

| Chain ID | Network | Purpose |
|---|---|---|
| `base-sepolia` | Base Sepolia testnet | Testing and development |
| `base-mainnet` | Base mainnet | Production |
