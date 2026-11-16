# Data services (`openapi-data`)

A data service is a seller's own HTTP API offered on the network. The buyer calls one of its
operations and pays a fixed price for each completed request, through the same payment channel
as any other service.

A data service is described by the seller's own OpenAPI document: its operations, their inputs
and what they return. The network defines no data formats and stores no description.

## Requests

The service is named in the path. The body is the operation's own: the proxy does not read it to
route the request and does not rewrite it, whatever fields it has.

| Request | What it does | Cost |
|---|---|---|
| `GET /v1/data/<service>/openapi.json` | Returns the seller's description of the service | Free |
| `<METHOD> /v1/data/<service>/<operation path>` | Runs one operation. The path, the query string and the body are passed on as sent; the proxy and the seller add their own `x-antseed-*` headers | One completed request for a 2xx answer with a body |

An operation's path is the seller's own API, so the seller passes it on with its percent escapes
(`/v1/data/flights/airports/New%20York`, an encoded service name) and a trailing slash
(`/v1/data/flights/search/`). It refuses, with `400 invalid_request_path` and before any payment
step, a path that could reach another operation than the one billed: a dot segment (`.` or `..`),
one that is encoded (`%2e%2e`), an encoded slash or backslash (`%2F`, `%5C`), any of these encoded
twice (`%252F`), an encoded control character, a malformed escape, a `;`, or an empty segment
anywhere but at the end. The query string is not checked. Paths of every other service keep the
strict rule: no percent escapes, empty segments or dot segments at all.

`GET /v1/data/<service>` is the same as `GET /v1/data/<service>/openapi.json`. Both are always
the free description, so an operation of the seller's own API at `GET /` or `GET /openapi.json`
cannot be sold through this path.

A buyer chooses a seller with the `x-antseed-pin-peer` header, with `<peerId>@<service>` as the
service in the path (`/v1/data/<peerId>@<service>/<operation path>`), or with a session pin.
The proxy sends the bare service to the seller.

A data call is one request and one buffered response. A `stream` field in the body or an
`Accept: text/event-stream` header is the operation's own and does not switch the proxy to
streaming.

A call other than a `GET`, `HEAD` or `OPTIONS` goes to one seller. If its answer fails or does
not arrive, the proxy does not send it to another seller, since the operation may already have
run, and it is not sent again to the same seller either. It moves on only after a refusal that
comes before the operation runs: a seller that does not serve the service, or a payment the buyer
could not make. Reads fail over like any other request.

A provider's own answers, errors included, come back as sent: the seller and the proxy do not
rewrite a data API's `401`, `403`, `413` or `429`, and do not judge a `2xx` by the shape of its
body. A `402` from the provider is its own error; only the seller's `payment_required` answer
starts a payment step.

The seller never rewrites a data answer's body: a `usage` or `cost` field in it is the API's
own data, so it is not replaced with the seller's price as an inference answer's is. A body the
provider sent compressed (gzip, deflate or br) is decoded, since the encoding header is not passed
on. Its headers pass the same filter as every answer: `content-type`, `content-disposition`,
`content-language`, `cache-control`, `retry-after` and `x-antseed-*`.

## Billing

Data services bill `completed_requests`, the unit model routing uses (see
[unit-billing-services.md](unit-billing-services.md)).

```ts
serviceApiProtocols: { flights: ['openapi-data'] },
serviceUnitBillingModels: {
  flights: {
    'openapi-data': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.005 }] },
  },
},
```

- An operation that returns a 2xx status with a body is one completed request. That includes an
  empty result set such as `{"rows":[]}`.
- A refusal, an error, a 2xx with no body and the description are free. A seller that wants an
  empty result to be free answers it with `204` or with no body.
- Buyer and seller run the same function on the same request and response bytes
  (`@antseed/buyer-core/unit-billing`), so they always agree on the charge.
- A billing model with no components is a free service.

There is no data-specific payment code. The price is in the service's listing, so the buyer
knows it before the call.

## Serving a data service

This repository ships no provider for the protocol. A provider plugin written to this page
serves it (start from [templates/provider-plugin/](templates/provider-plugin/)). For each data
service it:

- lists the service with `serviceApiProtocols: { <service>: ['openapi-data'] }` and a
  `completed_requests` price under `serviceUnitBillingModels`;
- answers `GET /v1/data/<service>/openapi.json` with the service's OpenAPI document. The seller
  node forwards this request to the provider before any payment step and charges nothing for it,
  so the provider should answer it from the document itself, without calling anything that costs;
- answers every other request under `/v1/data/<service>/` by running the operation in the rest
  of the path, and returns its response as is;
- may refuse a request it would not serve, such as an operation its document does not describe,
  with `Provider.checkRequest`. A refused request opens no channel and costs nothing.

`dataServiceRoute` in `@antseed/api-adapter` (also exported from `@antseed/node`) reads the
service, the operation path and whether a request is the description or a call.

## Describing a service

The document is the seller's own and the network does not check it. A description that a program
or a model can use without trial and error says, for each operation:

- what it does in one line, and where the data comes from;
- its inputs with their types, legal values, defaults and ranges;
- one worked example request;
- what comes back: a response schema, or at least one example answer;
- which answers are errors, so the caller knows what is free;
- whether the call is safe to repeat, and the longest it may take.

And for the service as a whole, in OpenAPI's own fields:

- `info.version`. Readers should ignore fields they do not know, so a description can grow
  without breaking them;
- `info.termsOfService`, `info.license` and `info.contact` for the terms that govern the data
  and who provides it;
- extension fields (`x-...`) for anything else the provider wants to state, such as terms in a
  machine-readable form or a link to a credential about the provider.

## Discovery

Peer metadata v18 adds the `openapi-data` protocol. Sellers still serve v12 to v17 to older
buyers with data services left out, so those buyers keep seeing the seller's other services.
The description is not stored in peer metadata; buyers fetch it from the seller.

Data services are listed with type `data` (`GET /v1/models?type=data`), priced per request.
A service that announces a chat protocol first and `openapi-data` second stays a text service
and answers on both.

Health probes are off for data services: an operation is the seller's own and may cost it
money per call.

## Limits

- The description request is forwarded to the provider without a rate limit, like the routing
  model list.
- The buyer's price caps in `router-local` are per million tokens. They are applied to the
  service's token prices and do not judge a per-request price.
- Streaming answers are not supported: every data call is buffered.

## Not covered yet

A price per operation, the operation name and input hash in the SpendingAuth metadata, the
buyer proxy as an MCP server, and desktop and gateway console screens for data services.
