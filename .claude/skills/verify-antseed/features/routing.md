# Routing

The buyer picks a seller for each request: the one a request pins with `<peerId>@<model>`, or the best one by its routing when the request names only a model. It only ever sees sandbox sellers.

## Sub-features

- `route-pin` sends a pinned chat to the named seller.
- `route-auto` spreads model-only chats across available sellers.
- `route-isolated` sees only sandbox sellers.
- `route-settle` settles each seller exactly.

## How to get to it (user POV)

- Set the model to `<peerId>@<model>` in a client, or only `<model>`.

## Driving it with sb

Preconditions:

- `pnpm sandbox run routing-smoke --chain local` (two sellers with different mock latency).

- **Pinned.** `sb.chat({ model: `${seller.peerId}@${model}` })` for each seller. The reply contains that seller's id.
- **Auto.** Six model-only chats. Each reply comes from a sandbox seller.
- **Isolation.** The buyer's peers are exactly the sandbox sellers.
- **Proof.** `routing-smoke` prints `PASSED`. Paste `checks.log`.

## Gotchas

- Routing services and routing beyond the buyer's own routing are not covered (see `../SKILL.md` Gaps).
- A topology change needs `pnpm sandbox down` first, or `run` refuses.
