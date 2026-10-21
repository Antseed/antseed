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
serviceApiProtocols: { 'alpha-route': ['irp-suggest'] },
serviceUnitBillingModels: {
  'alpha-route': {
    'irp-suggest': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] },
  },
},
pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
```

## How it is billed

Routing uses the same unit-billing path as images: one billing adapter for every
routing protocol in `@antseed/buyer-core/unit-billing`, which asks the protocol's
wire binding (`RoutingWireProtocol` in `@antseed/protocol/routing`) which
candidates a rank request sent and whether the answer is a usable ranking. Buyer
and seller run the same adapter on the same request and response bytes. For
`irp-suggest`, a 2xx IRP ranking that names at least one sent candidate counts
as 1. Anything else counts as 0. Because both sides compute the same count, a malformed answer is free on
both sides and never leaves the seller waiting for an authorization.

Channel opening, top-ups, 402 retries, NeedAuth validation and settlement are
the existing payment flow. There is no routing-specific payment code.

## Compatibility

Old buyers reject an announcement containing the unknown `completed_requests`
unit, which removes that seller's whole announcement, not just the routing
service. Run routing services on separate peers until buyers upgrade.
Routing services are left out of the network service catalog and health probes.
