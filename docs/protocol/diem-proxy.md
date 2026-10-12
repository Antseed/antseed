# DIEM Staking Proxy

## Overview

`DiemStakingProxy` is a Solidity contract on Base that lets DIEM token holders pool their stake, re-stake it into Venice (for API inference credit), and share the resulting Antseed seller revenue (USDC + ANTS) pro-rata.

Venice's DIEM token (`0xf4d9…a024`) is both an ERC20 and its own staking contract — `stake(uint256)` / `initiateUnstake(uint256)` / `unstake()` live on the token itself. The proxy re-stakes via that same contract, acts as the permanent on-chain seller address for Antseed, and relays channel actions through an operator EOA. It also implements ERC-1271 so Venice's API-key issuance flow can verify signed challenges against the operator.

The on-chain seller changes from "peerId's derived EVM address" to "the proxy contract address". Buyers learn this at runtime from a signed `SellerDelegation` attestation the peer publishes in its metadata.

## Architecture

```
 ┌──────────────┐                        ┌───────────────────┐
 │  DIEM holder │  stake(amount)         │  DIEM token       │
 │  (alice)     │─────────────┐          │  (ERC20 + staking │
 └──────────────┘             │          │   0xf4d9…a024)    │
                              ▼          │                   │
                      ┌───────────────────┐                  │
                      │  DiemStakingProxy │── diem.stake ────┤
                      │                   │── diem.init...  ─┤
                      │  • staked[user]   │── diem.unstake ──┤
                      │  • pending[user]  │                  │
                      │  • usdcStream     │                  └── API-key entitlement
                      │  • antsStream     │                     (off-chain; operator holds
                      │  • ERC-1271       │                     key, Venice verifies sig
                      └────────┬──────────┘                     via proxy.isValidSignature)
                               │
       ┌───────────────────────┼────────────────────────┐
       │                       │                        │
       ▼ reserve/topUp/        ▼ operatorClaimEmissions  ▼ getReward()
         settle/close            (epochs[])               (by user)
       ┌─────────────┐       ┌──────────────────┐       ┌──────────────────┐
       │ AntseedCh-  │       │AntseedEmissionsV2│       │ USDC / ANTS      │
       │ annels      │       │                  │       │ safeTransfer     │
       └──────┬──────┘       └────────┬─────────┘       └──────────────────┘
              │                       │
              │ chargeAndCredit       │ claimSellerEmissions
              ▼                       ▼
       ┌─────────────┐         mints ANTS to msg.sender = proxy
       │ AntseedDep- │         ──► proxy._notifyRewardAmount(antsStream, Δ)
       │ osits       │
       │ safeTransfer│
       │ (seller=prxy)         ──► proxy._notifyRewardAmount(usdcStream, Δ)
       └─────────────┘
```

The operator EOA is a signer/relayer only. It signs `SellerDelegation` off-chain and calls `reserve/topUp/settle/close/operatorClaimEmissions` on the proxy on-chain. It never custodies DIEM, USDC, or ANTS belonging to stakers — the proxy is the sole custodian.

The **operator EOA is the peer identity wallet** loaded by the daemon (`loadOrCreateIdentity`). That same key already signs peer metadata and makes seller-side channel calls, so no second key is introduced. The proxy's `operator` must be set to the peer identity's EVM address; rotating the operator means rotating the peer identity.

## `SellerDelegation` schema

EIP-712 typed data:

- **Domain**
  - `name`: `"DiemStakingProxy"`
  - `version`: `"1"`
  - `chainId`: Base chainId (8453 mainnet, 84532 Sepolia)
  - `verifyingContract`: the proxy contract address

- **Type**
  ```
  SellerDelegation(
    address peerAddress,
    address sellerContract,
    uint256 chainId,
    uint256 expiresAt
  )
  ```

- **Signer**: the current `operator` EOA (as returned by `proxy.operator()`).

- **On-wire shape** (`SellerDelegationPayload` in `packages/node/src/discovery/peer-metadata.ts`):
  ```jsonc
  {
    "peerAddress":    "aabbccdd...ee",       // 40 lowercase hex, no 0x
    "sellerContract": "112233...99",          // = proxy address, 40 hex
    "chainId":        8453,
    "expiresAt":      1747000000,             // unix seconds
    "signature":      "11...cc"              // 130 hex (65-byte secp256k1 sig)
  }
  ```

- **Publishing**: embedded inside the signed peer metadata body (codec v8+). The metadata signature binds the delegation to the publishing peer, preventing replay to a different peerId.

- **Lifetime**: short (default 1 hour). The peer's announcer re-signs before expiry and republishes updated metadata automatically.

## Buyer verification flow

```
 1. P2P handshake:  ecrecover(sig, peerId) == peerId's pubkey
                    (unchanged; no RPC)

 2. Fetch metadata over HTTP. Decode v8 binary body.
    → If version mismatch → drop peer (fail-closed via validateMetadata).

 3. resolveSellerAddress(peerId, metadata):
      if no sellerDelegation     → return peerIdToAddress(peerId)

      check chainId == ourChainId
      check expiresAt > now
      check peerAddress == peerIdToAddress(peerId)
      check cache[hash(delegation)] is fresh (< 5min)
        if cached & fresh         → return cached sellerContract

      RPC: read proxy.operator()
      recovered = ecrecover(EIP712(SellerDelegation), sig)
      check recovered == operator → else THROW (drop peer; no fallback)

      cache[hash] = { sellerContract, verifiedAt: now }
      return sellerContract

 4. resolved address is used as `seller` for:
      computeChannelId(buyer, seller, salt)
      ReserveAuth.channelId (via computeChannelId)
      SpendingAuth.channelId (via computeChannelId)
      ChannelStore.sellerEvmAddr
      staking.getAgentId(seller)   (discovery loop)
```

Cache TTL: 5 minutes. Rotation detection: when the cached `operator` value no longer matches the on-chain `operator()`, verification fails → the entry is discarded; a fresh read picks up the new operator on next resolve.

**Fail-closed**: if a peer publishes a delegation and verification fails for any reason (expiry, chain, signer mismatch), the resolver throws `SellerDelegationVerificationError`. The caller drops the peer rather than falling back to `peerIdToAddress` — a lying peer that publishes a bogus delegation must not succeed in being treated as a normal peer.

## Reward accounting

The DIEM pool applies a 10% fee before USDC reaches the staking pool. That fee flows to the Protocol Reserve to strengthen the Antseed ecosystem and ANTS. The remaining USDC is streamed pro-rata to stakers.

Two parallel streams: `usdcStream` and `antsStream`. Each uses the Uniswap StakingRewards pattern:

- `rewardRate` (tokens per second), `periodFinish`, `lastUpdateTime`, `rewardPerTokenStored`.
- Per-user `userUsdcRewardPerTokenPaid`, `userAntsRewardPerTokenPaid`, `usdcRewards`, `antsRewards`.
- `earned(account)` view returns `(usdcEarned, antsEarned)`.

`notifyRewardAmount` is **internal only**. It fires inline, in the same tx as the inflow:

- `settle(...)` and `close(...)` — pre/post `usdc.balanceOf(this)` diff. Delta > 0 → `_notifyRewardAmount(usdcStream, delta)`.
- `operatorClaimEmissions(epochs)` — pre/post `ants.balanceOf(this)` diff. Delta > 0 → `_notifyRewardAmount(antsStream, delta)`.
- `topUp(...)` — captures any USDC delta if the embedded settle brings inflow.
- `reserve(...)` — no inflow, no notification.

Default `rewardsDuration` is **1 day** per stream (owner-adjustable via `setRewardsDuration(stream, seconds)`, only while the stream's `periodFinish` has passed). One-day smooths inflow cadence (operator typically settles every few minutes to hours) without letting rewards linger stale.

Accrual boundaries around withdrawals:

- `stake(amount)`: runs `_updateStream` for both streams on the staker before mutating `staked`.
- `initiateUnstake(amount)`: runs `_updateStream` first, then decrements `staked` and enters the Venice cooldown. The requested portion **stops accruing rewards immediately**.
- `unstake()` (after cooldown): pure DIEM transfer; no reward math.
- `getReward()`: runs `_updateStream`, transfers both stream balances, zeros them.

## Venice unbonding (two-step withdrawal)

Venice's DIEM contract imposes a cooldown on unstake (currently 1 day; admin-settable on Venice's side). Consequences for the proxy:

- `initiateUnstake(amount)` calls `diem.initiateUnstake(amount)` and records `pendingWithdrawal[user] = { amount, unlockAt = now + diem.cooldownDuration() }`. Repeated calls accumulate and reset the caller's own `unlockAt`.
- `unstake()` checks the caller's `unlockAt`, then pulls the pending batch from Venice via `diem.unstake()` if the proxy's DIEM balance is insufficient — which reverts if Venice's shared cooldown hasn't elapsed yet. Once successful, transfers the caller's share.
- **Shared-bucket side effect** (inherent to DIEM's contract): Venice tracks a single `coolDownEnd` per staker. Since the proxy is the staker, every user's `initiateUnstake` resets the Venice cooldown for all pending withdrawers. Per-user `unlockAt` on the proxy is tracked independently, but a late requester can delay an earlier requester's actual DIEM release. The proxy surfaces this honestly (the first revert from `unstake` cites Venice's `COOLDOWN_NOT_OVER`), but does not work around it.
- No cancel-initiateUnstake path in v1. A staker that wants to stay staked must wait out the cooldown, call `unstake()`, and call `stake()` again.
- The cooldown value is read from Venice (`diem.cooldownDuration()`) on every `initiateUnstake` — no duplicated state on the proxy to sync.

## Deployment runbook

Prerequisites: Base mainnet (or Sepolia); owner EOA with ETH for gas; operator EOA for channel ops; USDC for Antseed staking minimum.

1. **Deploy `DiemStakingProxy`** with constructor args:
   - `_diem`: `0xf4d97f2da56e8c3098f3a8d538db630a2606a024` (DIEM — both ERC20 and staking contract)
   - `_usdc`: Base USDC (mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
   - `_ants`: Antseed ANTS token address (check `packages/node/chain-config.json`)
   - `_channels`: real `AntseedChannels` address (not the proxy itself)
   - `_emissions`: `AntseedEmissionsV2` address
   - `_antseedStaking`: `AntseedStaking` address (needed so the owner can later recover the seller stake via `withdrawAntseedStake`)
   - `_operator`: the operator EOA (= the peer identity wallet address)
   - `_usdcRewardsDuration`: `86400` (1 day)
   - `_antsRewardsDuration`: `86400` (1 day)

2. **(Optional) transfer ownership to a multisig** via `Ownable.transferOwnership`. Distributes operator-rotation risk across N signers.

3. **Register an ERC-8004 agentId** for the proxy address. Call `IdentityRegistry.register(<proxyAddress>)` (or whatever the deployed registry's signature is) — this is a separate tx targeting the ERC-8004 contract, not the proxy. The returned `agentId` is used by `AntseedStaking` and `AntseedEmissionsV2` to identify the proxy as a seller.

4. **Stake minimum on `AntseedStaking`** so the proxy can call `reserve()`:
   - Owner approves USDC to `AntseedStaking` for at least `MIN_SELLER_STAKE`.
   - Owner calls `staking.stakeFor(<proxyAddress>, <agentId>, <amount>)`. Because `stakeFor` pulls USDC from `msg.sender`, the owner funds this, not the proxy.

5. **`setOperator(address)`** — only if the operator needs to be different from what was set in the constructor.

6. **Configure the seller peer**:
   - In the seller CLI config (`~/.antseed/config.json` or equivalent), set `payments.crypto.channelsContractAddress` to the **proxy address** (not the real `AntseedChannels` address). The seller's `ChannelsClient` will now call `reserve/topUp/settle/close` on the proxy.
   - Set `payments.sellerDelegation.sellerContract` to the proxy address.
   - The peer identity wallet (loaded from the normal Antseed identity store) signs `SellerDelegation`. No separate operator private key / env var is introduced — the `operator` set on the proxy **must** equal the peer identity's EVM address.

7. **Restart the seller peer**. Verify:
   - Peer metadata on announce includes `sellerDelegation` (check decoded metadata output).
   - First buyer connects and opens a channel: tx on-chain is `proxy.reserve(...)` → emits `ForwardedReserve`, internally calls `AntseedChannels.reserve` with `seller = proxy`.
   - On settle: `ForwardedSettle(channelId, cumulative, inflow)` emits with `inflow > 0`; stream rates update.

## Operator runbook

- **Rotate operator**: because the operator is the peer identity, rotation is a two-step process — (a) generate a new peer identity (start the new peer instance), (b) owner calls `setOperator(newPeerIdentityAddress)` on the proxy. Event `OperatorRotated(old, new)`. Buyers re-verify within ≤5 min (resolver cache TTL). The new peer's announcer automatically publishes a fresh `SellerDelegation` signed by the new identity; older signatures no longer verify. Shift traffic from old to new peer as desired.
- **Change reward duration**: call `setRewardsDuration(streamIndex, seconds)` where `streamIndex` is `0` for USDC, `1` for ANTS. Only valid while the stream's `periodFinish` has passed. To force a window close, wait out the existing period or pause settles.
- **Venice cooldown changes** propagate automatically — `cooldownDuration()` is read from Venice on each `initiateUnstake`. Existing pending withdrawals retain the `unlockAt` set at the time of their request.
- **Decommission / recover seller stake**: owner calls `withdrawAntseedStake(recipient)` to invoke `AntseedStaking.unstake()` on the proxy and forward the recovered USDC to `recipient`. AntseedStaking enforces "no active channels" itself. Slashed amounts (if any) stay with Antseed's protocol reserve. This USDC is owner capital, not staker reward — it does not flow through the reward streams.
- **Emissions claim cadence**: operator chooses when to call `operatorClaimEmissions(epochs[])`. Claiming more frequently smooths reward rate spikes but costs gas per tx. Weekly is a reasonable default; monthly acceptable.

## Out of scope / known limitations

- **No cancel-initiateUnstake**: once a staker enters the cooldown, they must wait.
- **No multi-operator support** at the contract level. Distribute key-custody risk by using a multisig as the proxy owner (the multisig can rotate the single operator EOA).
- **No migration of legacy channels**: existing `ChannelStore` records keep their original `sellerEvmAddr`. New channels opened after the proxy goes live use the proxy address.
- **Buyers on metadata codec v<8**: do not see delegated peers. The strict `version !== METADATA_VERSION` check in `validateMetadata()` causes old buyers to reject v8 peers outright — this is the rollout correctness mechanism.
- **Venice API-key lifecycle**: entirely off-chain. The proxy re-stakes DIEM into Venice; the operator holds and manages the resulting API key. The proxy implements ERC-1271 (`isValidSignature`) so Venice's API-key issuance flow can verify signed ownership challenges against the current `operator`. Rotating the operator immediately invalidates API keys signed by the old operator.
- **No EIP-1271 in the handshake**: the P2P handshake stays zero-RPC and ecrecover-only. Delegation is application-layer, verified once per ~5 minutes of session.
