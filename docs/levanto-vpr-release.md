# Routing VPR desktop verification

## Integration contract

Use [model-routing](protocol/model-routing.md) as the canonical IRP wire
contract and [completed-request billing](protocol/unit-billing-services.md)
for the billing rules. This guide covers desktop behavior and verification,
not a separate Levanto protocol.

The desktop discovers exact `model-routing` offers through
`GET /_antseed/routing-services`. The buyer uses `ModelRoutingClient.listModels`
to request free IRP `GET /v1/routing/models` over the selected peer's control
plane. The same model-list cache is shared with ranking, with a 60-second TTL.
The desktop catalog contains network provider/model pairs whose names match
the router's models exactly or by canonical model key.

Router settings persist an exact peer/provider/service target, an optional
integer `costQualityTradeoff` (0 best quality, 10 cheapest), and optional exact
`allowedModels`. Unset tradeoff uses the IRP default 5. An unset allowlist means
all supported models; an empty list means none. Legacy preference maps are
rejected rather than interpreting the old scale in the opposite direction.

Settings autosave. Editing an inactive router does not select it; **Use** selects
it. Active edits update the buyer's future requests without restarting connected
apps or replacing an in-flight request's selection.

The main process translates renderer selections into the buyer's route API:
`{ model: null, router: { service, costQualityTradeoff?, allowedModels? } }` for
router mode, and `{ model, router: null }` for an explicit model. A configured
explicit model takes precedence when reading a route with both fields.

The router only ranks: the buyer sends inference to the chosen seller and pays
that seller independently. A successful ranking is one completed-request
purchase, regardless of candidate count; model-list discovery is free. Eligible
tool-loop continuations can reuse the ranking. The router receives the whole
conversation supplied with the request, so the public guides explain this
additional recipient before buyers choose a routing service.

## Local development

Use Node 24.21.0 and build the workspace first. In separate terminals:

```sh
pnpm dev:levanto levanto-vpr-release
pnpm dev:desktop:instance levanto-vpr-release
```

The first command starts a foreground fake router and a local discovery node.
It offers free recommendations for the exact GesundAI target configured in
`e2e/scripts/gesundai-router.mjs`; inference is billed normally by that seller.
The fixture checks availability through the buyer's `/v1/models` endpoint,
default port 8377. Pass a second argument to select a different buyer port.
It serves models and ranks over P2P; no separate HTTP catalog port is needed.

If an older buyer is running, stop it in its owning app or terminal before
starting the updated buyer. A named desktop instance may reattach to a shared
buyer rather than restart it. A 404 on `/_antseed/routing-services` indicates
that the buyer does not support discovery for this UI.

## Checks

```sh
export PATH=~/.volta/tools/image/node/24.21.0/bin:$PATH
pnpm install
pnpm run build
pnpm run typecheck
pnpm --filter @antseed/desktop run typecheck:renderer
pnpm --filter @antseed/desktop test
pnpm --filter @antseed/cli test
pnpm --filter @antseed/router-core test
pnpm test:levanto
ANTSEED_LEVANTO_BROWSER=1 pnpm --filter @antseed/e2e exec vitest run tests/levanto-vpr.e2e.test.ts
```

The last suite covers the browser harness and real local P2P. Its paid-chain
variant additionally requires Foundry and `ANTSEED_LEVANTO_CHAIN=1`. Test
providers are development fixtures, not production provider plugins.

Check both slider endpoints and reset-to-default, persistence across reloads,
empty and custom allowlists, unavailable/stale model lists, routing failures,
explicit-model overrides, and chat's actual-model indicator. Confirm that
discovery never buys a ranking or inference and that rejected recommendations
do not broaden the allowed models.

The public documentation lives in the [AI VPN guide](../apps/website/docs/guides/vpr.md#delegate-model-selection-to-a-routing-service),
[buyer API guide](../apps/website/docs/guides/using-the-api.md#select-a-routing-service),
and [provider guide](../apps/website/docs/guides/become-a-provider.md#offering-a-model-routing-service).
Check documentation changes with `pnpm --filter @antseed/website build`.
