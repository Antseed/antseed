# desktop-deposit-and-credits

After a paid chat the desktop credits view equals the on-chain deposit minus the reserve, and the deposit view produces a correctly signed pay URL (address and amount) for the card checkout.

Status: planned, no scenario yet.

## What to test

- credits and balance views (VprCreditsView, credits-balance.ts)
- card checkout pay URL (apps/desktop/src/main/payments/portal.ts, apps/payments/src/card-link.ts); Stripe itself stays external

## What the testbench needs first

- accessible names on the credits and deposit views
- a pay-URL capture hook in the desktop driver

Targets: local, fork. Capabilities: desktop, mockControl.
