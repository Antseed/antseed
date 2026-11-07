# seller-upstream-errors

The mock answers with an out-of-credit body and with a 429 plus Retry-After: the buyer sees upstream-unavailable or rate-limited with the retry-after kept, the seller account is never exposed, and nothing is charged.

Status: planned, no scenario yet.

## What to test

- upstream account errors hidden from buyers, extra-usage answers treated as account errors
- 429 normalization with mixed-case Retry-After
- self-health errors (packages/node/src/health)

## What the testbench needs first

- mock fault kinds credit-exhausted and 429-retry-after (lib/mock.mjs has only 500 and disconnect)

Targets: local, fork. Capabilities: mockControl.
