# Completed-request billing (model routing)

| Purchase | Measurement | Example |
| --- | --- | --- |
| Images | Delivered images, capped at the requested number | 2 × $0.04 = $0.08 |
| Routing ranks | 1 for a well-formed ranking, otherwise 0 | 1 × $0.001 = $0.001 |
| Token inference | Existing input, cached-input and output usage | Unchanged |

A ranking with five ranked candidates is one completed request. A response counts as well-formed when it is an IRP `routing.ranking` with a non-empty `ranked` list.

## Provider configuration

```ts
services: ['alpha-route'],
serviceApiProtocols: { 'alpha-route': ['model-routing'] },
serviceUnitBillingModels: {
  'alpha-route': {
    'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] },
  },
},
pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
```

## How it is billed

Routing uses the same unit-billing path as images: a billing adapter for the
`model-routing` protocol in `@antseed/buyer-core/unit-billing`. Buyer and seller
run the same adapter on the same response bytes. A 2xx response with
`version: 1` and at least one recommendation counts as 1. Anything else counts
as 0. Because both sides compute the same count, a malformed answer is free on
both sides and never leaves the seller waiting for an authorization.

Channel opening, top-ups, 402 retries, NeedAuth validation and settlement are
the existing payment flow. There is no routing-specific payment code.

## Compatibility

Old buyers reject an announcement containing the unknown `completed_requests`
unit, which removes that seller's whole announcement, not just the routing
service. Run routing services on separate peers until buyers upgrade.
Routing services are left out of the network service catalog and health probes.
