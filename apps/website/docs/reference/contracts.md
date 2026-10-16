---
title: Contract addresses
slug: /contracts
description: Addresses of the Antseed protocol contracts on Base mainnet and Base Sepolia, and the external ERC-8004 registry they use.
---

# Contract addresses

These are the contracts the CLI, gateway, and desktop app use by default. They are built into `@antseed/node` (`packages/node/src/payments/chain-config.ts`, generated from the deployment ledger in `packages/contracts/deployments`), so you never need to configure them for Base mainnet. SDK users can read them with `getChainConfig('base-mainnet')`, and `antseed ants addresses` prints the addresses in use.

Settlement, fees, and channel mechanics are described in [Payments](/docs/payments); ANTS rewards in [Recognized usage](/docs/recognized-usage).

## Base mainnet (chain ID 8453)

| Contract | Address | Role |
|---|---|---|
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Settlement token |
| AntseedRegistry | `0xf33fC901BFa97326379A369401F4490E231B69B0` | Address book for the other protocol contracts |
| AntseedDeposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` | Buyer USDC deposits and seller payouts |
| AntseedChannels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` | Paid payment channels (holds no USDC) |
| AntseedFreeUsage | `0xB24DcDE777C4ad9AC385Ec9500b3Dc527a4F91Ad` | Zero-price usage channels |
| AntseedDepositRelay | `0x34a44542e76f9b4cff3a31902eDF14AbF2C3B3DD` | Gasless USDC sweeps into Deposits |
| AntseedStats | `0x15649ff076BFa5e37e24EE3154a00503149954Fd` | Per-seller token and request counters |
| ANTSToken | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` | ANTS token |
| AntseedSellerRegistry | `0x99c533BCc6Ca646E543dbA835Fdbb9C2ee02Cb60` | Seller eligibility and agent ID binding |
| AntseedSellerPools | `0x8Bf4d39AA13F3CB03F87D9500767fBc4D0940652` | Locked ANTS positions and pool power |
| AntseedPositionInit | `0xB68AD13b681319fcEB6b0A640c2fd96C0138CBc8` | Starter positions for legacy sellers |
| AntseedUsageAccounting | `0xAdd2D85316153D7bfaF7921EE9Bf1Bb6c7A1cBc9` | Recognized buyer and seller usage points |
| AntseedPointsPolicyRegistry | `0x212D2C1058b84507de248a147aaFeB08fb19E3b6` | Ordered usage-point policies |
| AntseedWashTradingPointsPolicy | `0x7a605aaa3c725aa25012dfDeD6B5dddcC561D6e5` | Zeroes points for proven wash traders |
| AntseedWashTradingRegistry | `0xc02a111CB94332Cc31C08E079cbe781880b2121C` | Proven wash-trading verdicts |
| AntseedEmissionsGate | `0xE60a31E6CD2F8455503cA0B3f6545Dd3DDF543BD` | ANTS emission schedule and allocations |
| AntseedSellerPoolsRewards | `0x83cc5B9AA0c8cB8683F35462c385a5BAAa755EE5` | Staker rewards |
| AntseedUsageRewards | `0x78330bF154172F1137219Bb559d4F3A270B3201F` | Buyer and seller usage rewards |
| AntseedLegacyEmissionsEscrow | `0x4d0fC3C0BBb5233Af6c4Ce33223e5330c34db9ab` | Escrow for pre-epoch-22 rewards |
| AntseedLegacyRewardsPoolRegistry | `0xF76590430d9fCe0E871107Aa1f1AE796B0d03a11` | Legacy locked-rewards pool adapter |

The protocol reserve that receives USDC protocol fees is read from `AntseedRegistry.protocolReserve()` (currently `0xBF348D3eEDA2012c60375ebFe4Eb46511859f70F`).

### Legacy contracts

The pre-epoch-22 USDC staking and emissions contracts are used only for historical claims. Their addresses are listed on [Legacy emissions](/docs/legacy-emissions#legacy-contract-addresses).

## Base Sepolia testnet (chain ID 84532)

The testnet has the payment contracts and legacy staking and emissions only; it has no recognized-usage, free-usage, or deposit-relay contracts.

| Contract | Address |
|---|---|
| USDC (test) | `0xcA04797CaB6B412Cee6798B7314a05AdFDc3Cf23` |
| AntseedRegistry | `0x81562e904D228Ee05DB473f5c9453F0f0D65ad5A` |
| AntseedDeposits | `0x96f083A9801AFdcE7D764651954A1A9Fbd489FEA` |
| AntseedChannels | `0x3b0b94AC27C042CAC17103A897Fb5cEb7D8b4cf7` |
| Staking | `0x1CB76B197a20E41f9AA01806B41C59e16Cad46a7` |
| Emissions | `0x9B30DAcfC20F0927fFD49fB0B84cf3EB83976a33` |
| ANTSToken | `0x10B2B40d7aDEBAB0f8a9567fc90973Fbb997aE61` |

## External registries

Seller identity uses the deployed [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) IdentityRegistry; Antseed did not deploy it.

| Registry | Chain | Address |
|---|---|---|
| ERC-8004 IdentityRegistry | Base mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 IdentityRegistry | Base Sepolia | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

You can inspect any of these on [BaseScan](https://basescan.org).
