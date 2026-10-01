# Shared unit billing and routing

## What gets counted

| Purchase | Measurement | Example |
| --- | --- | --- |
| Images | Delivered images, capped at the requested number | 2 × $0.04 = $0.08 |
| Completed requests | One accepted successful response, otherwise zero | 1 × $0.001 = $0.001 |
| Token inference | Existing input, cached-input and output usage | Existing token rates, unchanged |

A routing response with five recommendations is one completed request, not five
requests or five images. Predicted downstream tokens/prices are not routing usage.
The unit calculator and payment channels are shared; measurement differs.

## Provider configuration

API format and pricing are separate. A routing seller (for example a ranking service) supplies `handleRequest`
and ordinary provider configuration:

```ts
services: ['alpha-route'],
serviceApiProtocols: { 'alpha-route': ['model-routing'] },
serviceUnitBillingModels: {
  'alpha-route': {
    'model-routing': {
      version: 1,
      components: [{ unit: 'completed_requests', priceUsd: 0.001 }],
    },
  },
},
pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
```

There is no `serviceExecution` map or separate execution-contract configuration.
The buyer's `ModelRoutingClient` validates its `POST /v1/routing/rank` body and
the response, including `version: 1`, before accepting recommendations (see
[model-routing.md](model-routing.md)). The shared API
adapter only identifies the protocol. Providers are responsible for validating
their own API requests and returning non-success responses for rejected work;
the generic seller handler does not inspect the routing payload schema.

`priceUsd: 0.001` costs 1000 micro-USDC; `priceUsd: 0` makes the service free. The current routing
buyer supports completed-request pricing, not token-priced routing. Nonzero token
surcharges are rejected because the completed-request adapter does not measure
backend tokens. Supporting token-priced routing requires actual usage reporting.

## Request and payment flow

1. The seller advertises a signed offer identifying provider, service, API format
   and unit billing model. The buyer verifies it and applies its own maximum price.
2. The buyer sends the normal request with `unitBilling: offer` and a synchronous
   `acceptResponse` callback. Only literal `true` accepts delivery. The SDK adds the
   existing provider header; no unit-price or service-contract header is sent.
3. The seller checks the request method, provider, and confirmed reserve, then executes. Initial
   pre-execution 402 negotiation uses the existing channel handshake and retries
   once. It does not prepay the routing charge.
4. The seller measures successful provider responses; the buyer additionally
   validates and accepts delivery. The shared calculator computes the charge;
   existing version-1 usage reports contain
   `{version: 1, units: {completed_requests: '1'}}` (or `'0'`).
5. The existing payment manager signs, persists and settles cumulative
   SpendingAuth. Failed, cancelled and rejected responses receive no buyer
   authorization; duplicate response/NeedAuth processing cannot charge twice.

Buyer price limits, channel correlation and exact charge validation remain.
Like images, completed requests carry the advertised `UnitBillingModelV1`
through to accounting (`offer.unitModel`). The SDK derives a micro-USDC amount
only for price checks and payment negotiation; it does not rebuild a billing
model from that amount. Request tracking snapshots the model so later changes
cannot change an in-flight purchase's agreed charge.

A provider that returns HTTP success with an invalid payload can cause a seller
charge that the buyer refuses to authorize. Providers must validate their own
responses; buyer validation is not a substitute for seller-side validation.
A seller price change after discovery can cause disagreement after execution;
the buyer does not automatically increase its authorization or replay the work.

## Concurrency and retries

Routing uses ordinary request dispatch, without a separate seller queue, busy
guard or executed-request cache. Existing channel-close and payment checks stay
in place. Reserve checks do not reserve funds for in-flight work, so concurrent
requests can pass against the same remaining balance.

Ambiguous transport failures must not be replayed automatically: the seller does
not guarantee exactly-once provider execution. Buyer duplicate-charge protection
remains separate and uses request correlation and the durable channel store.

## Compatibility

Existing image-v1 metadata, prices, rounding and `output_images` reports are
unchanged. Token billing is unchanged. New completed-request purchases require
upgraded buyers and sellers. The signed `completed_requests` billing model
identifies the offer; there is no separate advertisement or connection capability
flag for this billing mode. Sellers do not reject incompatible buyers through an
upfront capability check, so incompatibility may instead fail later during payment.

Discovery keeps signed metadata v12. Both image and completed-request prices use
`providers[].serviceUnitBillingModels`: the existing version-1 component layout
with `priceUsd`. `output_images` keeps unit ID 0; `completed_requests` adds ID 1.
There is no special `offerings` entry or new metadata layout. Completed-request
prices must round to the same micro-USDC amount before and after the existing
float32 metadata encoding; prices that lose that precision are rejected.

Old buyers can still buy from upgraded sellers advertising only existing image
and token services. An old decoder rejects the **entire announcement** containing
the unknown `completed_requests` unit, not just that service. Keeping metadata at
v12 does not make the new unit readable by old buyers. Initially, run completed-request
services on separate peers. Mixed sellers require upgraded buyers for all their
services. Routing and completed-request services stay out of ordinary inference
listings. Routing health probes are skipped based on API format, not pricing.

The unreleased generic execution API and contract-based offering names are not
preserved. Buyers and sellers using those branch-only formats must upgrade.

## Verification

After building, run `pnpm --filter @antseed/protocol --filter @antseed/node run test`.
The regular suites cover metadata encoding and signatures, image billing,
completed-request schema validation, price limits, response acceptance,
concurrency and mixed-service operation. They use the current source tree and
do not fetch or execute historical buyer code; compatibility against an old buyer
implementation is not tested automatically.
Live settlement and the router's private backend still need an authenticated smoke
test. See the router README for selection, fallback and conversation accounting.
