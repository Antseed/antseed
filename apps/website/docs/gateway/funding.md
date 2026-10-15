---
title: Funding and the authorized wallet
slug: /gateway/funding
sidebar_label: Funding
description: Add funds to a workspace by card or USDC on Base, withdraw, manage payment channels, set the authorized wallet and claim rewards.
---

# Funding and the authorized wallet

Each workspace pays providers from its own wallet. You add funds by card or by sending USDC on Base. You do not need to hold crypto already: a card payment delivers USDC to the workspace's wallet for you.

**Wallet & Funding** and **Rewards** are open to workspace admins and organization admins.

## Workspace wallets

Every workspace has its own wallet (a buyer identity), with its own credits, payment channels and spend. The **Default** workspace pays from the buyer's `default` wallet. Creating a workspace creates a new wallet for it. See [The gateway](/docs/gateway) for how workspaces fit together.

Credits are USDC deposited for paying providers: 1 credit = 1 USDC. The running buyer moves USDC that arrives in the wallet into its credits automatically. A small fixed relay fee is deducted, and the wallet never needs ETH for gas.

## Add funds

Open **Wallet & Funding** and click **Add funds**. The dialog shows the **Workspace balance** and an amount picker ($5, $10, $25 or any amount).

### Card

Click **Deposit $10 by card** (with your amount). It is powered by Crossmint and accepts the usual cards and wallets such as Apple Pay and Google Pay. The checkout opens inside the console and closes by itself once the funds arrive; **Open in a new tab** opens it separately.

- Each card payment is between $1 and $200, with at most two decimals. For more, send USDC.
- Card checkout is not available in every region.
- US customers can also choose **More options → Deposit using Outerfound** (card, US only, powered by Stripe).

The USDC is delivered to the workspace's wallet and deposited into its credits.

### USDC on Base

Click **Quick deposit** to see the workspace's address and a QR code that any wallet app can scan. Send USDC on Base from an exchange withdrawal or another wallet. A status line follows the deposit, from **Waiting for USDC on Base…** to the amount added to the balance.

- Send only USDC on Base. Other tokens or networks are not deposited.
- The first deposit into a wallet must be at least $1.
- No wallet app on your phone? Click **No wallet on your phone? Pay from a connected wallet instead** to pay from a browser wallet.

Under **More options**, **Deposit using Meridian** accepts USDC from other chains.

### From the command line

`antseed gateway workspace show <workspace>` prints a workspace's wallet address. To show it as a QR code:

```bash
antseed --data-dir ~/.antseed/buyer-identities/<identity> buyer deposit --no-watch
```

For the Default workspace, use your data directory itself. Card checkout is only in the console.

## Deposit confirmations

**Deposits** on **Wallet & Funding** lists every deposit credited to the workspace, for workspace admins and organization admins. For each one it shows the date, the amount, where the USDC came from (a card purchase, a wallet, or a direct deposit) and whether someone approved it.

- **Approve** records your name, email and the time on the deposit, with an optional note such as a purchase order number. The approval is in the audit log, and **Remove approval** takes it back.
- Click the amount or **View confirmation** for a printable confirmation: the workspace, the date, the amount sent, the relay fee and what was credited, the workspace wallet, the deposit transaction, where the USDC came from, and the approval. **Print or save as PDF** saves it for your books.

The gateway checks every deposit against its transaction on Base, so the confirmation states only what the chain shows, with links to check it. It confirms a transfer into the workspace's prepaid credits and is not an invoice: no seller or other party issues one for a deposit.

The buyer writes deposits down as they are credited. For one made before that, **Add a past deposit** takes the transaction that credited it: the relayer's sweep, or your own deposit from a connected wallet.

## Balance and channels

The **Balance** panel shows:

| Figure | Meaning |
|---|---|
| **Available** | Credits ready to spend |
| **Reserved in channels** | Credits locked in payment channels with providers |
| **Authorized, not yet charged** | Spend signed to providers that they have not settled yet |
| **Credit limit** | The most the wallet's credits may hold |

**Payment channels** lists the workspace's channels with each provider: reserved, spent, and what returns on close. A channel opens the first time a provider serves the workspace. Organization admins can **Close channel**: the provider closes it and the unspent reserve returns to the balance. When the provider does not respond, **Close on chain** gives it 15 minutes to settle, after which **Withdraw reserve** returns the unused reserve. Both on-chain steps are signed by the authorized wallet, which pays the network fee in ETH on Base. [Payments](/docs/payments) explains how channels work.

**Withdraw** sends available credits to the workspace's authorized wallet, which must sign the withdrawal in your browser.

Balances, rewards and the authorized wallet are read from Base through the gateway's RPC endpoint. When the endpoint is rate limiting, the pages show the last known values with the note "Showing last known values — the chain RPC is busy." To use your own endpoint, see [Base RPC URL](/docs/buyer-config#base-rpc-url).

## Authorized wallet

Each workspace wallet has at most one **authorized wallet**. It is the only address that can withdraw the workspace's credits and claim its ANTS rewards, and both go to it. Requests keep working whether or not one is set.

The **Authorized wallet** panel on **Wallet & Funding** reads it from the chain:

| State | Meaning | What you can do |
|---|---|---|
| No authorized wallet | Nobody can withdraw or claim yet. | An organization owner authorizes one of their own wallets. Everyone else sees it read-only. |
| Your wallet | One of your sign-in wallets. | Connect it to withdraw, claim, or **Transfer or remove**. |
| Another member's wallet | Another member's sign-in wallet. | Only that wallet can withdraw, claim, transfer or remove it. |
| An unrecognized address | No member signs in with it. | Withdrawals and rewards go to that address, and only it can change the role. Ask whoever controls it to transfer it, or move to a new workspace. |
| The workspace wallet authorizes itself | Set up from the CLI with `--self`. | Hand the role to a personal wallet with `antseed gateway workspace operator transfer`. |

### Authorize a wallet

Only an organization owner can authorize a wallet when none is set, from a console session:

1. The wallet must be one of the owner's own sign-in methods, added at least 24 hours earlier. The panel lists the owner's wallets and when each becomes eligible.
2. The owner must have signed in within the last five minutes. Otherwise the console asks to confirm with a passkey or another wallet first.
3. Click **Authorize a wallet**, connect the wallet and click **Authorize this wallet**. The connected wallet submits the transaction and pays the Base gas.

Once set, only the authorized wallet can change it: connect it and use **Transfer or remove**. Removing it leaves the workspace without one until an owner authorizes a wallet again.

From the CLI, `antseed gateway workspace operator show <workspace>` reads the authorized wallet from the chain, and `antseed gateway workspace operator authorize <workspace> <address>` signs an authorization you can submit from any wallet. See [Commands](/docs/commands).

## Rewards

**Rewards** shows the ANTS the workspace's usage has earned per epoch, what is ready to claim, and the authorized wallet. **Claim rewards** sends them to the authorized wallet, which you connect in the browser to sign. Without an authorized wallet, nothing can be claimed. [Recognized usage](/docs/recognized-usage) explains how rewards are earned.

## Without a gateway

To fund a buyer you run without a gateway, use `antseed buyer deposit`, or the card checkout in the [desktop app](/docs/desktop). See [Payments](/docs/payments) for how deposits, channels and the authorized wallet work on-chain.

Next: [Budgets and spend limits](/docs/gateway/budgets).
