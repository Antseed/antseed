# Proposal: advertise a per-service prompt-size limit (`maxPromptTokens`)

**Status:** draft for discussion · **Target:** metadata v16 · **Area:** discovery / `serviceCapabilities`

## Problem

A seller's **context window** (`serviceCapabilities.contextWindow`) describes what the
*model* can handle. It is not the same as the largest prompt a *seller* will actually
accept for a service. Sellers that run a free or otherwise size-limited tier cap the
prompt they will serve as a matter of **policy** — typically far below the model's
context window — so that one oversized request cannot consume a shared budget.

Today that policy cap is invisible on the network. A buyer only discovers it by sending
a large prompt and getting it rejected (`400`) after the round-trip. On a free tier this
is common and wasteful: in practice we see prompts of tens of thousands up to ~1.2M
tokens sent to a service that accepts ~4k, every one rejected after transfer. The buyer
cannot tell "this seller is down" from "this prompt is too big for this tier," and
cannot route or truncate ahead of time.

## Proposal

Add an optional field to `ServiceCapabilities`:

```ts
/** Largest prompt (input tokens) this seller will accept for the service.
 *  A seller policy, independent of and usually smaller than `contextWindow`. */
maxPromptTokens?: number;
```

Semantics:

- **Hint, not contract.** Buyers SHOULD treat it as advisory and MAY pre-validate or
  truncate before sending; the seller still enforces and remains the source of truth.
- **Distinct from `contextWindow`.** `contextWindow` is a model capability;
  `maxPromptTokens` is a per-service seller policy that may be lower. A seller may set
  one, both, or neither.
- Absent means "unknown" (buyers fall back to their own defaults), exactly like the
  other optional capability fields.

## Wire encoding

The per-service capability **presence byte is full** (all 8 bits are assigned:
`contextWindow`, `maxOutputTokens`, `inputs`, `reasoning`, `toolUse`,
`structuredOutput`, `outputs`, `supportedParameters`). So a new field follows the
precedent set by `speech` at v15: a spare **value bit**, gated by the new version, with
a payload appended at the end of the entry.

- Add `CAP_VAL_MAX_PROMPT_TOKENS = 1 << 5` to the entry's value-bits byte, admitted only
  when the negotiated version is ≥ 16 (mirrors `CAP_VAL_SPEECH_OPTIONS`).
- When set, append a `u32` (the token count) at the end of the capability entry, after
  the speech options block. Bounded by the existing `MAX_CAPABILITY_TOKEN_COUNT`.
- Older versions never set the bit and never read the trailing `u32`, so **their signed
  bytes are unchanged** — buyers re-encoding v10–v15 documents still get identical
  hashes.

## Version & rollout

Follows the documented "add a version" recipe (`node/src/discovery/metadata/`):

1. `PROMPT_LIMIT_METADATA_VERSION = 16`; bump `METADATA_VERSION` to 16.
2. `versions/v16.ts` extends the v15 layout, adding `maxPromptTokens` to
   `capabilityOptions`; register it in `index.ts`.
3. `MIN_SUPPORTED_METADATA_VERSION` and `LEGACY_METADATA_VERSION` are unchanged. Buyers
   below v16 negotiate down and simply never see the field, as with every prior additive
   version.

## Validation

`maxPromptTokens` joins the existing `contextWindow` / `maxOutputTokens` check in
`validateServiceCapabilityFields`: a positive integer ≤ `MAX_CAPABILITY_TOKEN_COUNT`.
Shared by announce-time validation and provider config parsing so the two cannot drift.

## Seller config

Accept `maxPromptTokens` in the per-service capability config block alongside
`contextWindow`, so a seller can declare it without hand-editing metadata.

## Non-goals

- Not mandatory client-side enforcement — buyers may ignore it.
- Not a rate limit, a billing change, or a max-output limit (`maxOutputTokens` already
  covers output).

## Follow-up implementation

If the shape is agreed, the implementation PR adds: the field module change, `v16.ts`,
the config path, and golden/codec/validator test coverage (a v16 fixture and its hash;
the v10–v15 golden hashes stay byte-identical, which is the regression guard).
