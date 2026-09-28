# Levanto v1: supported models and exact routing constraints

This is the contract implemented by the AntSeed buyer and development fake
sellers. It is not a claim that Levanto's separately operated backend has deployed
it. The backend owner must implement and smoke-test this contract before release.
This interface is still under review and has not deployed: extend `v: 1` in place.
There is no second routing version, negotiation or peer-only compatibility path.
The endpoint remains `POST /_antseed/levanto-route`.

## Supported-model catalog (plugin `getCatalog()`)

Peer metadata is unchanged (v12): routers do not publish catalogs in discovery.
Instead, a buyer-side routing adapter may implement the optional
`ModelRouterAdapter.getCatalog(target, peers, signal)` hook and decide how to
obtain the catalog: hardcoded in the plugin, or fetched from the router's own API.
Returning `undefined` means supported models are unknown.

The Levanto adapter fetches it over HTTP from the router's API:

```
GET {routingPeerUrl}/_antseed/route/catalog?provider=<provider>&service=<serviceId>
```

`routingPeerUrl` comes from the router plugin setting `LEVANTO_ROUTING_PEER_URL`,
otherwise the routing peer's announced host on port `8787`. `404` means no catalog
(support unknown); other non-2xx responses and invalid bodies are catalog errors.
The response body is the catalog:

```ts
import type { RoutingCatalogV1 } from '@antseed/node';

const catalog: RoutingCatalogV1 = {
  version: 1, revision: 'catalog-1', title: 'Auto Router',
  models: [
  { provider: 'openai-responses', serviceId: 'gpt-6-astra' },
  ], preferencesSchema: {
  type: 'object', additionalProperties: false,
  properties: {
    strategy: { type: 'string', enum: ['fast', 'balanced'], default: 'balanced', description: 'Routing strategy' },
    region: { type: 'string', enum: ['eu', 'us'] },
  },
  required: ['region'],
  },
};
```

The catalog is `{ version: 1, revision, models, preferencesSchema, title? }`.
The optional `title` is a router-service display name, distinct from the seller's
existing peer `displayName` (for example seller `Levanto`, title `Auto Router`).
Titles must be trimmed nonempty strings of at most 128 characters, without control
characters. Routing discovery exposes the title
as `label` and the peer display name as `sellerName`, with provider-ID fallbacks.
`revision` is an opaque router-chosen string of at most 128 characters. Change it
when supported models or preferences change, and echo it on routing responses.
Catalogs are not signed or content-hashed by AntSeed.
Models are exact provider/service identifiers, not display labels, wildcards or
peer identities. Support does not promise current availability.

Limits: 512 models. Provider and service identifiers must be trimmed nonempty
strings of at most 128 and 256 characters respectively, without control
characters. An empty
`models` list explicitly means no supported models.

The buyer caches each routing service's catalog for 60 seconds with Query Core.
Failed fetches can retry on the next request. It drops the catalog after a failed recommendation, so a `409` catalog change is
picked up on retry. The catalog restricts candidates before the paid routing call
and its revision is sent as `catalogRevision`. The catalog fetch itself is not an
AntSeed purchase.

`GET /_antseed/routing-services` exposes each valid catalog and `catalogExpiresAt`
to desktop. A failed or invalid catalog exposes `catalogError`. A missing catalog
means support is unknown; desktop does not invent a supported-model list for it.

## Request

Settings belong to the routing service, not the desktop or a global CQT table.
For now the schema supports only flat named string enums, optional titles and descriptions,
defaults and required fields, with `additionalProperties: false`. An empty schema
means no configurable settings. Schema and preference objects are each bounded
to 16 KiB. Defaults must be valid enum values; duplicate/empty choices, unknown
fields, nested values, numbers and booleans are rejected.

Desktop displays each field's optional `title` (falling back to its wire key),
optional `description` underneath, and exact enum strings. Titles must be nonempty
strings. Routers should supply a short, human-readable title and a one-sentence
description. For example, Levanto can advertise the following field without
changing the request's `preferences.cqt` key:

```json
"cqt": {
  "type": "string",
  "title": "Cost quality",
  "description": "Balance lower cost against higher response quality.",
  "enum": ["1", "3", "5", "7", "9"],
  "default": "5"
}
```

It saves all selected fields across restarts and switching between model/router
mode. Required choices without defaults are not selected implicitly. Removed or
invalid saved choices remain visible for correction; discovery does not replace
them. The buyer resolves defaults and revalidates before purchasing a recommendation.
The seller must also call `resolveRoutingPreferences(catalog.preferencesSchema,
input.preferences)` before ranking. Preference changes also change the
catalog revision and invalidate cached routing decisions.

Requests always use `v: 1` and exact `allowedCandidates`. When the service publishes
a catalog, the buyer includes its `catalogRevision`; the seller must echo it.
Without a catalog, support is unknown and the revision is omitted on both sides,
but exact candidate constraints and provider identities are still required.
The buyer intersects any advertised catalog with discovery, availability, protocol,
price/trust/peer policy and the user's `allowedModels`.
No eligible candidates means failure **before buying a recommendation**.

The following v1 template uses a placeholder revision; replace it with the
advertised catalog's actual hash:

```json
{
  "v": 1,
  "service": "levanto-route",
  "catalogRevision": "<advertised 0x-prefixed SHA-256>",
  "preferences": { "strategy": "balanced", "region": "eu" },
  "inputMessage": "Explain this code",
  "promptTokens": 12,
  "expectedCachedTokens": [],
  "constraints": {
    "allowedPeerIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    "allowedCandidates": [{
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "openai-responses",
      "serviceId": "gpt-6-astra"
    }]
  }
}
```

Send to `POST /_antseed/levanto-route` over normal AntSeed service transport.
`allowedCandidates` must contain 1–512 unique exact tuples. All supplied
constraints apply together; `allowedPeerIds` never authorizes other models on a
listed peer. Values under `preferences` are strings from the selected router's
schema. There is no special top-level `cqt` field. Validate with the exported
`validateRoutingRequest` helper from `@antseed/router-levanto`.

When supplied, the seller must compare `catalogRevision` with its current catalog before ranking
and restrict ranking to the supplied exact tuples. Do not silently replace an
excluded model with an alias or another provider. If the backend only accepts
peer constraints, its seller must implement exact filtering/ranking before release;
simply ignoring the new field is not compatible with this v1 contract.

## Response and failures

```json
{
  "v": 1,
  "catalogRevision": "<same advertised SHA-256>",
  "router": "levanto",
  "ranked": [{
    "peer": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "provider": "openai-responses",
    "model": "gpt-6-astra",
    "estimate": { "costUsd": 0, "inputTokens": 12, "cachedInputTokens": 0, "outputTokens": 0 },
    "price": { "inUsdPerM": 0, "outUsdPerM": 0, "cachedInUsdPerM": 0 }
  }]
}
```

The example's zero prices are placeholders, not production price claims. Return
actual estimates and prices. The buyer checks response version, revision, exact
provider/model/peer and eligibility before accepting the routing purchase and
dispatching inference. Cache reuse is bound to the catalog revision, exact
candidate list, target and preferences. Model inference is a separate purchase.

- `400`: invalid request/version/constraints.
- `409`: `catalog_changed`; client must refresh discovery and retry explicitly.
- `422`: `no_allowed_candidates`; no supported/available destination satisfies constraints.
- Non-2xx responses are not completed recommendations and must not incur a
  completed-request charge. Validate successful rankings seller-side before billing.
- Never silently drop restrictions, broaden an explicit selection, retry a
  different router, or retry without constraints after a failure.

The earlier peer-only draft is intentionally unsupported. Requests without
`allowedCandidates` and recommendations without `provider` are rejected.
The buyer also filters inference destinations by the local allowlist, including
fallback destinations. Discovery metadata stays v12; the catalog is served by the
router's API independently of the metadata version and the Levanto request version.

## Release verification

Run the free browser/P2P tests and local Anvil payment suite documented in
`docs/levanto-vpr-release.md`. They cover model/router switching, exact constraints,
malformed responses, catalog mismatch, fallback, pins, streaming and settlement.
Then run a separate smoke test against the actual upgraded Levanto peer. Fake
tests cannot certify private backend compatibility or production settlement.
