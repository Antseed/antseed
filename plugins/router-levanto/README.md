# Levanto buyer router

`@antseed/router-levanto` is the buyer-only Levanto adapter used by the existing
`local` router. It asks a selected AntSeed
routing-service peer for ranked recommendations, then uses normal AntSeed
inference execution. Buyers select a routing service, not a different router plugin.

The remote recommendation endpoint is `POST /_antseed/levanto-route`. This is
separate from the generic local `/_antseed/route` control API, which changes the
buyer's selection rather than purchasing a recommendation.

Levanto operates its own seller integration and private backend outside this
repository. This package does not host their service, forward backend credentials,
or require `LEVANTO_BASE_URL` / `LEVANTO_API_KEY`. Seller-to-backend authentication
is not part of the buyer interface. Generic completed-request transport remains unchanged.

## Select the router

Install the matching SDK/CLI and local router, which includes this adapter.
Once published:

```bash
antseed plugin add @antseed/router-local
antseed buyer start
```

Once the buyer is running, select the service through the local route endpoint
shown below. Replace its example peer ID with the routing-service peer's actual ID.
The buyer never substitutes another routing-service peer because it is cheaper.
The selected peer must advertise a compatible `levanto-routing` completed-request
offer. Routing purchases use the selected service's advertised price, with no
separate routing-fee setting. Each purchase is bounded to that price snapshot;
there is no user-configured routing-price ceiling across future purchases.
Starting the local router does not enable routing-service mode:
without an explicit selection it stays in model mode.

This is a limitation of the current Levanto payment adapter, not a requirement
of the generic router interface. Routing selects an inference destination;
billing determines how a remote service is paid. The adapter currently does not
support selecting token-based or other billing modes for the recommendation.

Select the exact peer, provider and service through the local route endpoint;
there is no separate seller-peer setting or cheapest-peer default.
The advertised `levanto-routing` protocol identifies compatible services, rather
than a hardcoded provider name. The remaining plugin settings are the existing
local-router policy settings. Routing services stay out of the inference-model
catalog; clients render router-advertised settings from the plugin-provided
catalog schema.

In router mode, requests using `model: "antseed"` or
`model: "levanto-auto"` use the selected router, ignoring an old fixed-model
default. System-proxy-marked connected-app requests also use the selected mode,
not their connect-time model. Explicit client model choices and user conversation
pins remain overrides. Automatic conversation affinity is not a user pin.

Choose model mode to stop using the router:

```json
{ "kind": "model", "model": "your-model" }
```

The buyer plugin accepts user text from `messages` or Responses API `input`
(a string or message array). Downstream inference still uses the normal API
adaptation pipeline. Requests without usable user text fail explicitly.
Failures do not silently switch routers.

## Live selection and generic preferences

The SDK type is `RoutingSelection`: it represents either a direct model
choice or delegating that choice to a model-routing service. Selection is set
through the local control API and saved in `buyer.state.json`, not startup
configuration. The API supports changes without restarting:

```http
POST /_antseed/route
Content-Type: application/json

{
  "selection": {
    "kind": "router",
    "service": {
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "levanto",
      "serviceId": "levanto-route"
    },
    "preferences": { "cqt": "9" }
  }
}
```

`GET /_antseed/route` returns `{ "ok": true, "selection": ... }`. To select a
model, POST `{ "selection": { "kind": "model", "model": "your-model" } }`;
use `model: null` inside that selection to clear the default.
Selections are saved under `selection` in `buyer.state.json`. On upgrade, a valid
legacy `defaultRoutedModel` is converted and persisted once if `selection` is
missing. An existing `selection` always wins, including an explicitly cleared
default. The legacy key can remain in the file but is ignored after conversion.
The old top-level `model` API field is no longer supported.
Desktop/VPR and other model-only control clients need a follow-up update; this
change intentionally does not preserve their old selection API.
Selection changes apply to subsequent requests. In-flight requests retain their
original selection and are not cancelled by model or chat selection changes.
Client-disconnect cancellation remains in place. Explicit state selections
survive restart. Without saved selection, the buyer starts in model mode with no
default model. Existing price/trust policy configuration and hot reload are unchanged.

Conversation spend includes recommendation and inference costs and their reported
input, cached-input, and output tokens. Recommendation purchases do not add an
extra conversation request count. A recommendation reporting zero tokens adds
no tokens; token usage is not suppressed just because it came from a router.

Preference schemas come from the service catalog's `preferencesSchema`, which the
adapter's `getCatalog()` fetches from the router API (`GET /_antseed/route/catalog`,
base URL `LEVANTO_ROUTING_PEER_URL` or the routing peer's host on port 8787). The same transport can serve different routing services with
different settings. The buyer validates the exact selected service's schema.
For example, a CQT field:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "cqt": {
      "type": "string",
      "enum": ["1", "3", "5", "7", "9"],
      "default": "5",
      "description": "Cost/quality preference"
    }
  }
}
```

The shared enum validation/hash machinery follows the former routing PRs 3/5:
router-defined flat string choices, optional defaults/descriptions/required fields,
unknown-value rejection, and a 16 KiB schema/value bound. It is not a global CQT
enum. `RouteSelectionContext` carries current effective preferences, their schema
hash and the selected service. Routing v1 sends a generic `preferences` object
with string values, not a top-level numeric `cqt`. A seller integrating Levanto's
private API can translate its own `preferences.cqt` to that backend's format.

Schemas are bound to the catalog and its revision, an opaque string chosen by
the router and echoed as `catalogRevision`. Defaults and
choices are validated before a routing purchase and again seller-side. Changed
or removed choices fail validation rather than being silently replaced. Required
fields without defaults require an explicit choice; optional fields can be unset.
No free text, numbers, booleans or nested fields are supported.
Without a catalog, the adapter descriptor remains the buyer's fallback;
the built-in adapter has no settings. A different wire protocol still needs a
registered adapter, but no client-specific settings code.

## Registering another routing adapter

The local router uses `ModelRouterRegistry` from `@antseed/router-core` to
resolve the exact selected peer/provider/service's advertised API protocol.
Levanto is registered by default under `levanto-routing`; its provider name is
not used to choose the adapter. Unknown protocols and ambiguous advertisements
fail instead of falling back to Levanto.

An adapter implements `ModelRouterAdapter` from `@antseed/node`: `routingMetadata`
and `selectRoute(request, peers, context)`, with an optional `recordUsage` hook.
The method returns generic `RouteRecommendation[]` values.
Its request construction, response validation and any billing mode selection
stay inside the adapter, while candidate eligibility and inference execution
remain shared.

Code integrating an additional adapter can pass it to the local plugin's `createRouter` method:

```ts
import localPlugin from '@antseed/router-local';

const router = localPlugin.createRouter(config, {
  'another-routing-protocol': anotherAdapter,
});
```

Here `anotherAdapter` is an instance implementing `ModelRouterAdapter`. The protocol
must also be supported by discovery metadata; registering an adapter does not
extend metadata's wire format. This is explicit code registration, not automatic
discovery or installation of arbitrary npm plugins. For built-in integrations,
add a default registration alongside Levanto in the local router factory.

The buyer validates live selections and resolves preferences using the selected
service's catalog schema (or adapter fallback), and resolves it again from current peers before execution.
Selections loaded before discovery are structurally checked immediately; their
adapter/schema is checked before any routing purchase. In model mode the local
router has no selected routing schema. Inference usage observations are shared
with registered adapters so their independent cache estimates can stay warm;
selection changes reset each adapter's decision cache.

## Per-conversation router settings

Each existing conversation can save its own routing-service peer and preferences
through the local control API:

```http
POST /_antseed/conversations/update
Content-Type: application/json

{
  "id": "vpr:your-session-id",
  "routingSelection": {
    "kind": "router",
    "service": {
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "levanto",
      "serviceId": "levanto-route"
    },
    "preferences": { "cqt": "9" }
  }
}
```

Use the actual conversation ID from `GET /_antseed/conversations`. The response,
conversation list, and individual conversation GET include `routingSelection`.
Overrides persist in `conversations.json` and survive buyer restart. Existing
conversations without this field inherit the buyer-wide selection.

An override requires an explicit routing-service target. Preferences are validated
against the loaded plugin's schema; omitted preferences use schema defaults, not
another chat's or the buyer's preferences. The peer must be supported by that
installed plugin. This selects an external service, not a different installed
plugin. An unavailable plugin or incompatible preference schema fails routing
rather than silently falling back to the buyer default.

To remove the override and follow the current buyer default again:

```json
{ "id": "vpr:your-session-id", "routingSelection": null }
```

Selecting a chat router clears its previous model/seller pin. Setting a new
explicit user model/seller pin replaces the router override. Update only one of
`routingSelection` and `pinnedModel` in a request. Explicit model/peer choices on
inference requests remain overrides; automatic affinity does not override the
chat router. Buyer-wide inference-peer pins do not replace an explicit chat router.

Child/subagent requests inherit their parent chat's selection while maintaining
separate cache observations. Changing a chat override or the buyer-wide selection
does not cancel ongoing requests; subsequent requests use the updated selection.
No additional desktop controls are included.

## Recommendation filtering

The buyer's existing price, trust, peer-policy, availability, protocol and required
parameter checks produce exact eligible model/peer/provider candidates. A plugin-provided
supported-model catalog further limits these candidates. The v1 plugin always
sends `constraints.allowedCandidates` with exact `{ peerId, provider, serviceId }`
tuples, plus `catalogRevision` when a catalog is available. A response must
echo any supplied revision and include the exact provider on every accepted destination.
Excluded tuples fail before inference and response acceptance. Catalog changes
(409) and empty intersections (422) never trigger a retry without constraints.

The response must use `v: 1` and have at most 512 ranked entries.
Malformed or unsupported entries, disallowed peers, and ineligible model/peer
combinations are removed individually. Remaining entries keep their original
order. A peer having one eligible model does not make its other models eligible.
An invalid envelope or no usable destination fails before response acceptance.

There is one in-review v1 contract, without version negotiation. The earlier peer-only
draft is intentionally unsupported. Routers without a catalog still receive exact
constraints, but their supported models are unknown. An invalid or expired catalog
is an error, not permission to omit it. Clients must not present the network-wide
model list as that router's supported-model list.

Levanto's external backend must implement the catalog API and this revised
contract before release.
Unsupported inference overrides are rejected as a whole candidate, not stripped.
The backend's predicted prices are not authoritative inference prices.

The existing executor deduplicates destinations, rechecks eligibility and required
verification before each inference attempt, and tries remaining ranked destinations
on explicit retryable failures. Cancellation, buyer faults, payment-required
responses, timeouts, ambiguous transport failures and started streams stop fallback.
Neither an unlisted inference destination nor another routing peer is substituted.

## Cache observations

After a successful completed inference, the host reports native input/cache usage
through `Router.recordUsage`, before client-protocol conversion. Routing-service
calls, failures, cancelled requests, estimated usage and unidentified conversations
do not contribute observations. Streaming usage is recorded from the completed
response, not once per chunk. Child conversations are separate from their parents.

Levanto estimates cache warmth using its existing behavior: cached/input ratio,
EMA weight 0.5, previous-prompt and current-prompt caps, and three-minute expiry.
Observations are scoped by conversation, peer, provider and model. Duplicate
request observations are ignored; memory is bounded to 500 conversations, 64
offers and 512 recent request IDs per conversation. Only currently eligible
candidates contribute `expectedCachedTokens`. Ambiguous providers for the same
model/peer use the conservative minimum estimate.

This is independent from decision reuse: unchanged latest user text can reuse
eligible recommendations within a conversation. Target, preferences or schema
changes invalidate reuse. No decision database, daily digest or savings UI is
added.

## External service compatibility

Routing and billing are separate. The Levanto buyer plugin defines its routing
endpoint and validates its payloads; the shared API adapter only identifies the
protocol. Providers validate their own API requests and responses, while
`serviceUnitBillingModels` selects how to charge. No `serviceExecution`
configuration is required. `levanto-routing` identifies the API format,
not its billing unit. The current Levanto integration supports
`completed_requests`: an accepted routing response counts as one unit, whether it
contains one or five recommendations. A price of zero makes that service free.
This does not make every router a paid service. Token-priced routing would need
real backend token measurements; predicted inference tokens are not such usage.

The SDK uses the same unit-cost evaluator and cumulative payment channel as image
billing, but a different measurement adapter. Images measure `output_images`;
routing measures accepted `completed_requests`. The SDK supplies the existing
provider header; no unit-price or service-contract header is sent. Like images, the
buyer retains the advertised unit billing model for accounting and derives its
price for the purchase maximum. A seller price change after
discovery can therefore cause a payment disagreement after execution, but cannot
automatically increase the buyer's authorization. See
`docs/protocol/unit-billing-services.md` for provider configuration.

The generic seller handler counts successful provider responses without checking
Levanto's payload schema. If a provider returns HTTP success with an invalid
payload, the buyer rejects it and will not authorize the seller's charge.
The seller can then refuse subsequent purchases on that channel with HTTP 402
because its completed-work total exceeds the buyer's authorized total. The
buyer reports a payment error; the user can select a model or another router. There is no automatic disputed-charge authorization, refund, or channel
recovery. Providers must validate successful responses before returning them;
this behavior is a paid-rollout acceptance gate, not just a transient retry.

The endpoint and `v: 1` request/response bodies identify the routing format;
there is no separate execution-contract setting. Completed-request pricing uses
the existing version-1 component shape, for example
`{ unit: 'completed_requests', priceUsd: 0.001 }`, directly in
`providers[].serviceUnitBillingModels`. Signed metadata stays at v12; no special
`offerings` entry is needed. Existing image/token-only announcements remain readable
by old buyers, but an old buyer rejects the whole announcement if it includes the
new unit. Run routing services on separate peers initially; mixed sellers require
upgraded buyers for all their services. Buyers and sellers must both upgrade to use
completed-request billing.

The external seller must implement the advertised Levanto routing API and
accept `POST /_antseed/levanto-route` with `service: "levanto-route"`, `v`, string-valued `preferences`,
`inputMessage`, `promptTokens`, `expectedCachedTokens`, and `constraints`.
The seller's handler must accept this API path;
the buyer does not retry the former remote `/_antseed/route` path.
Success responses contain `v: 1`, a nonempty `router` identifier, any supplied
`catalogRevision` and `ranked` entries with `model`, `peer`, `provider`, `estimate`, and `price`. Day-pass renewal responses
are not accepted by this per-response contract.

`service` identifies the advertised AntSeed offering that the seller dispatches
and bills. `model` in a ranked recommendation identifies the proposed downstream
inference model. They refer to different purchases. AntSeed's seller dispatcher
accepts `service` or falls back to `model`, but this plugin's routing request
schema uses `service`; it does not request inference from a model named
`levanto-route`.

Local tests verify the buyer contract and host integration. Live compatibility
with Levanto's privately operated service still requires an authenticated smoke
test against their actual AntSeed peer; no private backend credentials are needed
by this buyer package.
