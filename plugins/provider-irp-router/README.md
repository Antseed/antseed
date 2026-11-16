# @antseed/provider-irp-router

Serves an [Inference Routing Protocol](https://github.com/inference-routing/spec) (IRP) router on Antseed as an `irp-suggest` routing service. It is one routing provider plugin among others and has no special status: buyers pick routers the same way they pick any service.

The plugin forwards the two IRP suggest-only endpoints to your router unchanged:

- `GET /v1/routing/models`: free; the models the router can rank.
- `POST /v1/routing/rank`: billed as one `completed_requests` unit per well-formed ranking that names a candidate the buyer sent. Errors and malformed rankings are not billed.

Malformed rank requests are answered locally with IRP problem details and never reach the router. An unreachable router answers `503 urn:irp:problem:unavailable`.

## Run it

```bash
antseed config seller add-provider router --plugin irp-router --base-url https://router.example.com
antseed config seller add-service router my-router --input 0 --output 0
IRP_ROUTER_API_KEY=<key> IRP_ROUTER_PRICE_USD=0.001 antseed seller start
```

`--base-url` sets `IRP_ROUTER_BASE_URL`, and the service you add becomes `ANTSEED_ALLOWED_SERVICES`.

IRP paths name no service, so a seller offers at most one `irp-suggest` service.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `IRP_ROUTER_BASE_URL` | -- | Upstream IRP router base URL (required) |
| `IRP_ROUTER_API_KEY` | -- | Sent as `Authorization: Bearer <key>` |
| `ANTSEED_ALLOWED_SERVICES` | -- | Routing service id; exactly one (required) |
| `IRP_ROUTER_PRICE_USD` | `0` | USD per ranking; `0` makes rankings free |
| `IRP_ROUTER_TIMEOUT_MS` | `30000` | Upstream timeout |
| `ANTSEED_MAX_CONCURRENCY` | `50` | Max concurrent routing requests |
