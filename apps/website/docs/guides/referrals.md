---
sidebar_position: 9
slug: /guides/referrals
title: Referrals and Invites
hide_title: true
---

# Referrals and Invites

Antseed referrals are invite-only and two-sided. An invite is a single-use link
that a wallet with recent activity on the network signs and shares. A new user
who redeems it earns bonus ANTS from their own usage for 12 weeks, and the
person who invited them earns from that usage too.

The rules are enforced on-chain by the `AntseedReferrals` contract. The design
is described in AIP-6 ([proposal](https://github.com/Antseed/AIPs/pull/12)).

## What an invite is

An invite is signed off-chain by the inviting wallet. Creating one costs no gas
and nothing reaches the chain until someone uses it. It is shared as a link:

```text
https://antseed.com/invite/<invite>
```

Antseed Desktop also opens the same invite as `antseed://invite/<invite>`, and
the CLI accepts either the link or the bare `<invite>` code.

Every invite:

- **Works once.** The first wallet that binds it uses it up. Invites are bearer
  tokens, so share each one with one person rather than posting it publicly.
- **Expires.** An invite is valid for 4 weeks, counting the week it was created.
- **Is for new users only.** It binds only to a wallet with no recognized usage
  yet, or whose first recognized usage was at most 2 weeks ago, and that has no
  inviter yet.

## How you get invites

Invites are earned by activity. Your quota for a week comes from your
recognized activity in the previous week: your buying plus your selling, in
USDC, after reward policies such as the wash-trading exclusion.

| Previous week's activity | Invites this week |
|---|---|
| Less than 1 USDC | 0 |
| 1 USDC or more | 3, plus one more per 10 USDC |
| 170 USDC or more | 20 (the weekly maximum) |

Unused invites from a week's quota stay valid until they expire; the quota
itself does not carry over. Antseed epochs are weekly, so "week" here means a
protocol epoch.

## Create and share an invite

You can create invites from any Antseed client that holds your wallet. Each one
picks a free invite slot at random, so creating invites from several installs
of the same wallet rarely produces the same invite.

### Desktop

Open **Rewards**. The **Your invites** card shows how many invites you have
left this week. Click **Create link**, then **Copy**, and send the link. Below
it, Desktop lists the wallets that joined with your invites and what each has
earned you. Without enough activity last week the button is disabled and the
card explains why.

### CLI

```bash
antseed referral invite
```

```text
Invite created. Share the link; it works once and expires within 4 weeks.

  https://antseed.com/invite/<invite>

Invite: <invite>
<left> of <quota> invites left this week.
```

Add `--json` for machine-readable output.

### Dashboard

`antseed ants` opens the ANTS dashboard. Its **Rewards** page has a
**Referral rewards** card with your invites left this week, your payable
referral rewards and a table of the buyers you referred. Invites are signed by
the local Antseed wallet, so when the dashboard is driven by a browser wallet
it points you to `antseed referral invite` (or Desktop) to create one.

## Redeem an invite

Redeeming checks the invite against the contract for your wallet (with
`previewInvite`) and saves it as pending. It binds with your first paid or free
request: your client carries the invite in the settlement metadata it already
signs, so binding needs no transaction and no gas from either side. A rejected
invite never blocks a request. Once bound, your inviter is permanent.

### From the invite link

Opening `https://antseed.com/invite/<invite>` shows who invited you and the
date the invite expires, with three ways in: a download button for Antseed Desktop,
**Open in Antseed** (the `antseed://invite/<invite>` deep link, for Desktop
already installed), or a CLI command to copy.

### Desktop

Paste the code or link into the **Invite code** field and click
**Use invite**. Desktop checks it as you type and shows who it is from or why
it cannot be used. The field appears:

- on the setup screen during onboarding;
- on **Rewards**, in a **Have an invite?** card;
- in **Preferences → Referral**.

The field is shown only while your wallet has no inviter and no pending invite.
After that, Rewards and Preferences show **Invited by** with the inviter's
address, marked pending until the first request binds it.

The `antseed://invite/<invite>` deep link fills the same field: during
onboarding on the setup screen, afterwards by opening **Rewards** with the
invite prefilled.

### CLI

```bash
antseed referral redeem <invite>
```

```text
Invite from <inviter> saved.
Binds with your first paid or free request through `antseed buyer start` (before week <week>).
Then you earn bonus $ANTS on your usage for 12 weeks.
```

The invite is stored in `<data-dir>/referral.json`, and `antseed buyer start`
carries it until it binds. `antseed referral status` shows your inviter, your
bonus and your own invites:

```text
Invited by <inviter> (week <week>).
Invite bonus: <n> weeks left · <amount> ANTS payable. Paid to your authorized wallet.
Your invites: <n> invited · <amount> ANTS payable · <left> of <quota> invites left this week.
```

Invite lists, bonus amounts and binding status come from the Antscan explorer;
without one configured they are hidden.

## What both sides earn

Referral rewards are ANTS from a referral bucket of each epoch's emissions,
paid by `AntseedReferrals` as an emissions-gate controller. The bucket's share
of emissions is set by governance when the controller is registered with the
emissions gate. Each week's bucket is split pro rata to referral points among
everyone with a claim that week.

A referred buyer's recognized usage after the binding earns referral points:

- **Bonus window, 12 weeks after the binding:** the points count for both the
  inviter and the new user, so the two split that buyer's share 50/50.
- **After the window:** the inviter keeps earning from that buyer's usage
  alone.

Only usage recorded after the binding counts, and only recognized usage: the
same reward policies that apply to usage rewards apply here.

## Claiming

Claims are per week. A week becomes claimable once the following week has fully
ended. Claiming is permissionless, and the recipient is fixed by the contract:

- **The new user's bonus** is paid only to the buyer's authorized wallet (its
  Deposits operator), never to the buyer hot wallet. Until the buyer has an
  authorized wallet the claim cannot be made; it can be retried once one is
  set.
- **The inviter's rewards** go to the inviter's authorized wallet when it has
  one, otherwise to the inviting address itself (sellers and plain wallets).

A wallet can be both an inviter and an invited user; the two claims are
separate. Claim from the ANTS dashboard (`antseed ants`, **Rewards**). In
Desktop, **Claim rewards** and the **Invite bonus** card's **Claim** open the
same dashboard in your browser, because claiming needs the authorized wallet's
signature.

## Rules

- **New users only.** A wallet whose first recognized usage was more than 2
  weeks ago cannot be bound, and a wallet can be bound only once.
- **No self-invites.** An invite is rejected when it was signed by the buyer
  itself, by the buyer's authorized wallet, or by any wallet that shares the
  buyer's authorized wallet. These checks are repeated whenever usage is
  credited.
- **Single use and expiry.** Each invite binds at most one wallet and expires 4
  weeks after the week it was created.
- **Quota.** An inviter can bind at most its quota for the week an invite was
  issued in.

## See also

- [ANTS Staking](./staking.md) for the dashboard and claims
- [Recognized usage](../protocol/recognized-usage.md) for epochs, emissions and reward buckets
- [CLI commands](../cli/commands.md#referrals)
- AIP-6: [Antseed/AIPs#12](https://github.com/Antseed/AIPs/pull/12)
