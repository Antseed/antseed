# seller-refusals-before-payment

A bad model, a provider checkRequest refusal, an invalid billing request and an unmatched billing tier each return their error code and no SpendingAuth is signed.

Status: planned, no scenario yet.

## What to test

- model_not_found, provider.checkRequest, invalid_billing_request, billing_tier_unmatched 503 (packages/node/src/seller-request-handler.ts)
- the let-providers-refuse-before-payment path

## What the testbench needs first

- mock services that fail checkRequest on demand
- tb.request() error capture

Targets: local, fork. Capabilities: mockControl.
