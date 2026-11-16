# Security policy

Antseed software moves real user funds on Base mainnet. Please report security problems
privately so they can be fixed before anyone can use them.

## How to report

Use GitHub private vulnerability reporting:
<https://github.com/Antseed/antseed/security/advisories/new>

Do not open a public issue, discussion or pull request for a security problem, and do not
post details anywhere public.

If you have a fix, do not push it to a public fork or branch, and do not describe the problem
in a commit message or branch name: those are already public. Attach the fix to the private
report, or use the temporary private fork GitHub offers on the advisory.

## What counts

Report privately if you find any of these:

- A way to steal, lose or lock funds.
- A bug in the smart contracts (`packages/contracts`).
- A bug in payment channels or deposits that could move, charge or lock the wrong amount.
- A problem with signing or key handling, for example leaked keys or signatures that can be
  reused or forged.
- A way to get service without paying, or to bill a buyer for work that was not done.
- Any other problem that would let someone harm users if it were public.

If you are not sure whether something counts, report it privately.

## What to include

- What the problem is and what an attacker could do with it.
- The affected component, file or contract, and the version or commit.
- Steps to reproduce, or a proof of concept against a local chain or test setup.
- Any idea you have for a fix.

## What happens next

Maintainers acknowledge your report within 2 business days.

## Testing rules

- Do not test against other people's funds.
- Do not test against live sellers or buyers on mainnet.
- Use a local chain (for example Foundry's `anvil`) and your own wallets. A local fork of
  mainnet state (for example `anvil --fork-url <rpc-url>`) is fine for a proof of concept.
