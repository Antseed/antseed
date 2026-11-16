# 07 - Model Verification

**Status:** Mixed. `ResponseAuth`, `VerificationMux`, buyer-side response-auth
storage, and random buyer-side request/response evidence samples are implemented
in `@antseed/node`. Fingerprint verifiers, fingerprint swarm distribution,
reference storage, audit runners, and slashing are proposed next-step work.

## Overview

The reputation layer ([05-reputation.md](./05-reputation.md)) and metering layer
([03-metering.md](./03-metering.md)) answer **whether** a request was served and
**how much** was billed. Neither answers **what** was served.

A Seller can advertise a premium model (e.g. `claude-sonnet-4-6`) on the DHT and
silently serve a cheaper substitute — a different model family, a nano-tier
endpoint, or an aggressively quantized copy of the correct model. The Buyer pays
the advertised price and receives degraded output. Settlement volume,
ghost-channel rate, and ERC-8004 feedback all score the cheating Seller exactly
as well as an honest one, because delivery still happened.

This is not hypothetical. "Real Money, Fake Models" audits shadow APIs claiming
to serve official frontier models and finds utility, safety, and identity
divergence between claimed and served behavior
(https://arxiv.org/abs/2603.01919). Antseed's model-verification layer is the
protocol response to that failure mode: make served bytes attributable first,
then run black-box identity checks over attributable evidence.

**Model verification** is the set of mechanisms that let a Buyer gain confidence
that the model it paid for is the model it received, and — where the evidence is
strong enough — escalate a confirmed substitution to on-chain slashing. The v1
implementation target is a **buyer-run fingerprint suite** backed by signed
response evidence. The Seller is not trusted to provide the fingerprint result.

There is no central verification authority. Every mechanism here is either
Buyer-local or settled through existing peer-to-peer and on-chain primitives.

---

## Implementation Status

This spec intentionally separates the evidence substrate that already exists
from the fingerprint/audit layers that still need to be built.

### Implemented

Implemented in the `@antseed/node` package:

- `ResponseAuthPayload` protocol type:
  - `version`;
  - `requestId`;
  - optional `channelId`;
  - `buyerPeerId`;
  - `sellerPeerId`;
  - `advertisedService`;
  - `provider`;
  - `statusCode`;
  - `requestHash`;
  - `responseHash`;
  - `responseStartedAt`;
  - `responseCompletedAt`;
  - `signature`.
- Connection capability:
  - `verification.response-auth.v1`.
- Verification frame:
  - `MessageType.VerificationResponseAuth = 0x80`.
- `VerificationMux`:
  - sends response-auth frames;
  - waits by `requestId`;
  - buffers out-of-order auths;
  - allows one listener for unsolicited response-auth handling;
  - reserves `0x80-0x8f` for verification messages.
- Seller behavior:
  - creates `ResponseAuth` after a completed inference response;
  - signs with the Seller identity;
  - sends it only when the Buyer advertised `verification.response-auth.v1`,
    preserving compatibility with older Buyers.
- Buyer behavior:
  - waits for `ResponseAuth` after receiving the response;
  - verifies request hash, response hash, request id, status code, buyer id,
    seller id, advertised service, optional channel id, and Seller signature;
  - stores the auth and verification result in `verification.db`.
- Verification storage:
  - SQLite table `response_auths`;
  - indexed by seller, advertised service, and received timestamp.
- Buyer-side full evidence sampling:
  - random sample rate default `0.005`;
  - max encoded request + response bytes default `16 MiB`;
  - default directory `<dataDir>/verification_samples`;
  - stores `manifest.json`, `request.bin`, and `response.bin`;
  - stores only verified `ResponseAuth` samples.

The implemented evidence chain is:

```text
encoded request bytes
  -> requestHash
  -> ResponseAuth.signature
  -> response_auths row
  -> optional verification_samples/<sellerPeerId>/<sampleId>/
```

### Not Implemented Yet

Still proposed:

- `@antseed/fingerprints` package;
- KBF verifier implementation;
- non-KBF verifier families;
- public fingerprint swarm;
- buyer-local fingerprint reference store;
- KBF/fingerprint audit runner;
- audit result manifests under `<dataDir>/fingerprints/audits`;
- forced evidence storage for audit probes;
- local routing policy based on fingerprint verdicts;
- commit-reveal for slashable audits;
- off-chain exhibit verifier;
- on-chain slash signal for confirmed substitution.

The next implementation should build on the existing `ResponseAuth` and
verification sample substrate instead of replacing it.

---

## Threat Model

The adversary is a profit-motivated Seller that:

- Sees every request in plaintext before responding.
- Can run more than one backend and route each request to whichever backend it
  chooses, based on the request content.
- Will serve the advertised model only when it believes it is being watched, and
  the cheap substitute otherwise.

This last capability is the crux. **Any verification signal that is
distinguishable from ordinary Buyer traffic is a defeat device waiting to
happen**: the Seller detects the probe, serves the real model for that request,
and cheats everything else. Distinguishability is the property to design out, not
a detail to tune later.

A secondary adversary is a malicious **Buyer** that fabricates or cherry-picks
evidence to slash an honest Seller. Any mechanism that can trigger an on-chain
penalty MUST be robust against this.

External motivation:

- "Real Money, Fake Models" documents deceptive model claims in shadow APIs and
  motivates treating model identity as an auditable market claim, not a label to
  trust blindly: https://arxiv.org/abs/2603.01919.

---

## Mechanisms

The mechanisms below are layered. Each is independently useful; combined, they
form an `unattested → signed → attested` trust ladder consistent with the
existing reputation tiers.

### M1 — Behavioral Probes (weakest; bounded usefulness)

The approach proposed in issue #504. The Buyer (or a router middleware) injects
small structured prompts with deterministic, automatically scorable answers —
exact integer counts, fixed-schema JSON, multi-step arithmetic, fixed-length
output — and scores the response with a pure matcher function. An aggregate score
below a threshold over a session yields a fail verdict.

**Strengths:** zero Seller-side changes; cheap (≤30 output tokens per probe);
honest Sellers pass automatically; catches the lazy/casual substitution case.

**Limitations (MUST be understood before relying on this):**

- **Distinguishability.** Probes drawn from a fixed bank, sent as side-channel
  requests that bypass normal routing, are detectable by the adversary in the
  threat model above. A static probe bank published in this repository ossifies
  the moment it is public.
- **Tier, not identity.** Capability probes (arithmetic, format compliance)
  separate a nano tier from a frontier tier. They do **not** distinguish two
  models of similar capability (e.g. a 70B open model impersonating Sonnet), and
  they do **not** detect quantization of the correct model.
- **Self-reported identity is not a signal.** "Who made you?" probes are trivially
  defeated by a one-line system prompt, and open models routinely misreport their
  creator due to training contamination. This probe class SHOULD NOT be used.

M1 is acceptable as a cheap first-pass deterrent and as a way to prioritize where
to spend the more expensive mechanisms. It MUST NOT, on its own, drive on-chain
penalties.

### M2 — Reference Shadow Sampling (recommended core mechanism)

Instead of synthetic probes, sample **real** Buyer traffic. Because the probe is
an actual user request, the Seller cannot treat it differently without treating
all traffic the same way — distinguishability is eliminated by construction.

On a small random fraction `p` of real requests (default `p = 0.02`):

1. The Buyer sends the request to the selected Seller as normal.
2. The Buyer also sends the identical request to a **reference** for the same
   advertised model: the canonical upstream API (when the Buyer holds a key) or a
   TEE-attested peer (see M5) serving that model.
3. The Buyer stores both responses locally, keyed by the request.

A single (request, response) pair proves nothing: at any temperature, serving
stacks are not bitwise deterministic (batching, MoE routing, kernel differences).
Verification is therefore **distributional and accumulated**, never per-request:

- The Buyer accumulates `N` sampled triples for a given Seller (default `N ≥ 30`).
- It runs a two-sample statistical test comparing the Seller's output
  distribution against the reference's (e.g. a Model-Equality-style test over
  per-request similarity, or a distance over output-length / token-distribution
  features). This detects both family substitution and quantization in aggregate.
- Pass → samples are discarded; nothing is published. Fail → the Seller is
  flagged.

**Cost:** `2×` tokens on the sampled fraction only — i.e. ~`p` overhead on total
spend. Probe spend flows through the normal payment channel and SHOULD be tagged
in metering so it is distinguishable from organic usage for accounting.

### M3 — Signed Responses (non-repudiation; enables disputes)

M1 and M2 let a Buyer adjust its **own** routing. They do not, by themselves,
support a verdict any third party can trust, because an unsigned response is
hearsay: the Seller can claim the Buyer fabricated it.

To make verdicts portable, the Seller signs a `ResponseAuthPayload` after every
completed response when the Buyer supports `verification.response-auth.v1`.

```jsonc
{
  "version": 1,
  "requestId": "req-...",
  "channelId": "0x...",
  "buyerPeerId": "0x...",
  "sellerPeerId": "0x...",
  "advertisedService": "gpt-5.4",
  "provider": "openai",
  "statusCode": 200,
  "requestHash": "0x...",
  "responseHash": "0x...",
  "responseStartedAt": 1790000000000,
  "responseCompletedAt": 1790000001200,
  "signature": "0x..."
}
```

The merged implementation signs the following length-prefixed fields under the
domain tag `antseed-response-auth-v1`:

```text
domainTag
version
requestId
channelId || ""
buyerPeerId
sellerPeerId
advertisedService
provider
statusCode
requestHash
responseHash
responseStartedAt
responseCompletedAt
```

- `requestHash = keccak256(encodeHttpRequest(request))`.
- `responseHash = keccak256(encodeHttpResponse(responseWithoutStreamingHeader))`.
- The streaming marker header is stripped before response hashing so streamed
  and reconstructed responses hash consistently.
- Signature verification recovers against the normalized Seller PeerId.
- The Buyer verifies request hash, response hash, request id, status code, buyer
  id, seller id, advertised service, optional channel id, and signature.
- `ResponseAuth` is transported via `VerificationMux` as
  `MessageType.VerificationResponseAuth = 0x80`.
- The Buyer stores all received auths and verification results in the
  `response_auths` SQLite table.
- The Buyer may randomly store full request/response evidence in
  `<dataDir>/verification_samples`.

The signature binds *who emitted which bytes for which request*. It carries no
quality claim on its own — quality comes from M2's statistics or the fingerprint
verifiers in this spec.

The hash is a binding commitment, not a privacy mechanism: the Buyer retains full
plaintext. Hashing only avoids signing megabytes and lets a third party recompute
and verify cheaply.

Any Seller participating in a verifiable/signed trust tier MUST sign every
response requested by a Buyer that advertises `ResponseAuth` support. The
signature is unconditional: the Seller does not learn which responses the Buyer
will later sample, audit, or dispute.

Backward compatibility is implemented by connection-capability negotiation:

- new Seller + new Buyer: Seller sends `ResponseAuth`;
- new Seller + old Buyer: Seller does not send unsupported verification frames;
- old Seller + new Buyer: Buyer logs missing `ResponseAuth` and treats it as
  unavailable evidence, not a transport failure.

### M4 — Passive Fingerprinting (free; always on; triage only)

From ordinary traffic the Buyer derives per-Seller statistics that need no extra
requests: inter-token latency distribution, time-to-first-token, output-length
distribution, and stop/refusal patterns. Each Seller is compared against the
cohort of Sellers advertising the same model; outliers are flagged.

This is weak on its own (timing is noisy and environment-dependent) and MUST NOT
drive penalties. Its value is **triage**: it is zero-cost and tells the Buyer
where to spend M2 sampling budget instead of sampling uniformly.

### M5 — TEE Attestation (strongest; premium tier)

An attested Seller proves, via a hardware remote-attestation quote, which
endpoint and weights it serves. Attested Sellers:

- Require no statistical inference — the attestation is the proof.
- Double as the trusted **reference** for M2, which bootstraps verification for
  Buyers that do not hold canonical upstream API keys.

Attestation is the top of the trust ladder and is expected to command a price
premium. It is out of scope for v1 beyond reserving the tier.

---

## Fingerprint Verifier Suite

Fingerprint verifiers are black-box tests run by the Buyer against the Seller's
normal inference endpoint. They do not require the Seller to reveal weights,
runtime configuration, upstream credentials, or hardware claims.

Every verifier MUST follow the same contract:

1. It receives a `FingerprintReference` selected by the Buyer for an advertised
   service.
2. It emits normal `SerializedHttpRequest` objects that travel through the
   existing Buyer → Seller transport path.
3. It consumes the resulting `SerializedHttpResponse` bytes and the verified
   `ResponseAuth` for each request.
4. It writes an `AuditResult` with a deterministic verdict and enough metadata
   to reproduce the result later.

The initial suite SHOULD include the following verifier families. Each family is
independent; a failure by one family is routing evidence, not automatic slashing
evidence. Strong enforcement requires cross-family agreement or arbiter
confirmation.

### F1 — Knowledge Boundary Fingerprinting (KBF)

KBF probes facts near the claimed model's knowledge boundary: the reference model
answers them consistently, while contrast models answer differently or fail. The
canonical prompt form is numeric cloze completion:

```text
TASK: Answer these factual recall questions using only values stored in your weights.
RULES: Output ONLY in (N) <number> format, one per line.

(1) The melting point of tantalum carbide is ___°C.
(2) The diploid chromosome number (2n) of <organism> is ___.
```

KBF is useful because numeric answers are mechanically parsed and scored. It is
also limited: when multiple frontier models answer a probe set perfectly, that
probe set has no discriminating power. KBF therefore depends on fresh, private,
model-specific references, not only public probes checked into source control.

An Antseed KBF verifier MUST implement:

- domain-specific prompt templates;
- domain-specific numeric ranges and tolerances;
- position-aware numeric parsing using `(N)` prefixes;
- match-vector computation: `1` match, `0` mismatch, `null` unparseable;
- reference self-error loading;
- CP99 upper-bound computation for the reference error rate;
- one-sided binomial verdict computation;
- `SAME`, `DIFF`, `UNDETERMINED`, and `UNKNOWN` verdicts.

`SAME` means "not statistically inconsistent with the reference under this
probe set." It MUST NOT be represented as proof that the exact model was served.
`DIFF` is the only verdict that can become adverse evidence.

### F2 — Behavioral Classifier Fingerprints

The Buyer sends prompts selected because known models respond differently and
consistently. The response is converted into features such as refusal style,
format adherence, verbosity, JSON compliance, instruction-following behavior,
and answer shape. A classifier or nearest-reference scorer returns a model
identity score.

This family is broader than KBF and can detect stylistic or policy differences,
but it is easier to perturb with wrapper prompts. It SHOULD be treated as a
routing and triage signal unless combined with stronger evidence.

### F3 — Adversarial Trigger Fingerprints

The Buyer sends private trigger prompts that produce distinctive behavior in the
reference model but not in common substitutes. These prompts can include unusual
formatting, suffixes, ordering constraints, or instruction conflicts.

Triggers MUST be private and rotatable. Public triggers become defeat devices:
the Seller can route trigger-looking traffic to the real model and cheap traffic
elsewhere.

### F4 — Perturbation Fingerprints

The Buyer sends a base prompt and a set of semantic-preserving perturbations:
synonym swaps, clause reordering, punctuation changes, or equivalent JSON key
orderings. The verifier scores how output changes across the perturbation set.

This tests the model's response surface, not only its final answer. It is more
expensive than KBF because one logical probe expands into multiple requests.

### F5 — Tokenizer and Rare-Token Fingerprints

The Buyer uses prompts containing rare token fragments, unusual Unicode, or
tokenizer-sensitive strings. Models with different tokenizers or pretraining
distributions often degrade differently.

This family is useful for detecting model families and serving stacks. It is
fragile across sanitizers, relays, and wrapper systems, so it SHOULD NOT be the
sole source of an adverse verdict.

### F6 — Instruction-Hierarchy Fingerprints

The Buyer sends prompts that exercise system/user conflict handling, refusal
boundaries, schema repair, and hidden-instruction resistance. This often
fingerprints the **Seller stack** (base model plus wrapper), not only the base
model.

For Antseed this is still valuable: Buyers care about the service they receive,
including wrappers. For model-identity slashing, the verifier MUST distinguish
"different wrapper" from "different claimed model" in the verdict reason.

### F7 — Output-Distribution Fingerprints

When an API supports seeds, logprobs, top-token data, or repeated stochastic
sampling, the verifier compares output distributions instead of single answers.
This is strong when available and unavailable on many endpoints.

The verifier MUST record which distribution features were exposed by the Seller
or upstream-compatible API. Missing logprobs is not an adverse signal by itself.

### F8 — Service Runtime Fingerprints

The Buyer observes protocol and runtime behavior: error shapes, streaming chunk
cadence, headers, timeout behavior, context-window failure modes, and
OpenAI/Anthropic compatibility quirks. This identifies serving software or relay
type more than model identity.

Runtime fingerprints are triage signals. They can justify increasing KBF or
shadow-sampling budget, but they MUST NOT drive slashing directly.

### F9 — Passive Proxy-Reader Provenance

The Buyer analyzes ordinary signed responses after the fact with a provenance
classifier or "reader" model trained to infer which model family or serving stack
likely produced the text. READER-style methods fit here: they extract
representations from generated text and decode authorship/provenance without
requiring active challenge prompts.

This family is important because it can run over normal user traffic already
covered by `ResponseAuth`. It does not make audit traffic distinguishable to the
Seller, and it can prioritize which Sellers should receive active KBF,
behavioral, or perturbation audits.

Limitations:

- It is usually weaker than a targeted active audit for exact model identity.
- It may fingerprint the full Seller stack, including wrappers and system
  prompts, not only the base model.
- It needs calibrated references and should report confidence, coverage, and
  abstentions rather than forcing a verdict.

Reference: "READER: Robust Evidence-based Authorship Decoding via Extracted
Representations" (`arXiv:2606.10794`,
https://arxiv.org/abs/2606.10794).

---

## Package Boundaries

The implementation SHOULD be split into pure verifier logic and Antseed runtime
orchestration.

### `@antseed/fingerprints`

Day-one pure TypeScript package. No P2P, payment, SQLite, or provider
dependencies. This package is the canonical home for verifier interfaces,
reference schemas, public fingerprint-pack schemas, and the first implemented
verifier family.

Responsibilities:

- shared `FingerprintVerifier` interface;
- shared reference, probe, audit-result, and fingerprint-pack schemas;
- canonical JSON hashing for reference IDs, pack IDs, and audit IDs;
- verifier registry and dispatch by `kind`;
- KBF schemas and validators;
- domain definitions and tolerances;
- prompt construction;
- numeric parser;
- match-vector scoring;
- CP99 / binomial statistics;
- verdict computation;
- fixtures and tests using small public reference files;
- import/export helpers for public fingerprint packs.

Non-responsibilities:

- peer selection;
- sending network requests;
- verifying `ResponseAuth`;
- storing buyer evidence;
- fingerprint swarm discovery, fetching, seeding, and mirroring;
- slashing.

KBF is implemented as the first verifier module inside this package:

```text
packages/fingerprints/
  src/
    index.ts
    types.ts
    canonical-json.ts
    verifiers/
      kbf/
        index.ts
        domains.ts
        parser.ts
        scoring.ts
        verdict.ts
```

Future verifier families (behavioral classifiers, perturbation tests, rare-token
tests, runtime fingerprints, passive proxy-reader provenance) MUST plug into the
same package-level interfaces instead of creating one-off package APIs.

### `@antseed/fingerprint-swarm`

Optional package or node module for torrent-style public fingerprint pack
distribution. It is separate from pure verifier math because it needs discovery,
signatures, pack fetching, seeding, mirroring, and local trust policy. See
[08-fingerprint-swarm.md](./08-fingerprint-swarm.md).

Responsibilities:

- publish signed public fingerprint packs;
- discover packs by model/service/verifier kind;
- fetch and seed packs by content hash;
- validate pack signatures and provenance;
- maintain local trust scores for pack publishers;
- expose a swarm API to `@antseed/node`.

This can start as an `@antseed/node` module if creating a package is premature,
but the protocol and storage model MUST be designed as decentralized and
content-addressed from day one.

### `@antseed/node`

Runtime integration package.

Responsibilities:

- load references from buyer-local storage;
- discover and import public fingerprint packs;
- select which Seller/service pairs to audit;
- send audit requests through the ordinary Buyer request path;
- wait for and verify `ResponseAuth`;
- store full request/response samples using the existing verification sample
  format;
- call `@antseed/fingerprints` with parsed responses;
- store audit result manifests;
- expose routing/reputation hooks based on audit results.

`@antseed/node` MUST NOT embed verifier-specific math in request handlers. Request
handlers should only provide an authenticated request/response transport and
sample persistence surface.

---

## Reference Lifecycle

References are the durable inputs a Buyer uses to evaluate a Seller. They are
separate from audit results.

### Public References

Public references and fingerprints are useful for tests, demos, interop,
bootstrap, and network-wide reputation. They are weaker than private probes for
adversarial production use because a Seller can learn them, but they are still
strategically important: Antseed SHOULD become the decentralized public
fingerprint swarm for model fingerprints, verifier references, staleness
signals, and reproducible audit packs.

Repository fixtures MAY live in:

```text
packages/fingerprints/references/public/<model-slug>.json
```

If the checked-in set becomes large, move static fixtures to an optional data
package:

```text
packages/fingerprint-references/
```

Public references imported or adapted from third-party repositories MUST retain
license and provenance metadata in the file and package license notices.

Checked-in references are not the long-term distribution layer. The long-term
distribution layer is a public, decentralized, content-addressed fingerprint
swarm of signed packs. See [08-fingerprint-swarm.md](./08-fingerprint-swarm.md)
for pack announcements, swarm topics, seeding, mirrors, chunk hashes, and trust
policy.

### Private Buyer References

Private references are the normal production path. They are generated or
imported by the Buyer and stored locally:

```text
<dataDir>/fingerprints/
  references/
    <referenceId>.json
  audits/
    <sellerPeerId>/
      <auditId>.json
```

`referenceId` MUST be content-addressed:

```text
referenceId = "sha256:" || sha256(canonical-json(reference-without-local-fields))
```

The canonicalization function MUST be deterministic across platforms:

- UTF-8 JSON;
- object keys sorted lexicographically;
- no insignificant whitespace;
- finite numbers only;
- no `NaN`, `Infinity`, or `-Infinity`;
- no local filesystem paths in hashed content.

### Reference Schema

All verifier references share a common envelope:

```jsonc
{
  "version": 1,
  "kind": "kbf",
  "referenceId": "sha256:...",
  "referenceModel": "openai/gpt-5.4",
  "serviceAliases": ["gpt-5.4", "openai/gpt-5.4"],
  "createdAt": "2026-06-14T00:00:00.000Z",
  "source": "public | generated | imported",
  "generator": {
    "name": "@antseed/fingerprints",
    "version": "0.1.0",
    "verifierKind": "kbf",
    "params": {}
  },
  "provenance": {
    "license": "Apache-2.0",
    "url": "https://github.com/Ooo0ption/KBF",
    "commit": "<optional>"
  },
  "selfTest": {
    "hamming": 3,
    "total": 224,
    "coverage": 1.0,
    "errorRate": 0.0134
  },
  "probes": []
}
```

Verifier-specific payloads live inside `probes` and optional extension fields.
Unknown extension fields MUST be preserved by import/export tools and ignored by
verifiers that do not understand them.

### KBF Probe Schema

```jsonc
{
  "id": "chemistry_mp:tantalum-carbide",
  "name": "tantalum carbide",
  "domain": "chemistry_mp",
  "template": "The melting point of {name} is ___°C.",
  "consensus": 3880.0,
  "range": [-300, 4000],
  "tolerance": {
    "mode": "absolute",
    "value": 3.0
  },
  "consensusRaw": {
    "t0": 3880.0,
    "t07_a": 3880.0,
    "t07_b": 3880.0
  },
  "contrast": {
    "model": "qwen/qwen3.5-9b",
    "value": 3980.0,
    "agrees": false
  }
}
```

Generation rules:

- A probe is valid only if the reference model answers consistently under the
  configured consensus passes.
- A probe SHOULD be screened against one or more contrast models.
- Numeric comparison MUST use the probe's domain tolerance.
- A probe set SHOULD include multiple domains so a substitute cannot overfit one
  narrow capability.
- Public probe sets MUST be considered stale over time. Stronger future models
  may answer all old probes correctly.

---

## Buyer Audit Execution

A Buyer audit is a normal Antseed request sequence with extra local bookkeeping.
The Seller should not be able to tell whether a request is user traffic or audit
traffic.

### Audit Selection

The Buyer chooses `(sellerPeerId, advertisedService, referenceId, verifierKind)`
using local policy:

- random background coverage;
- higher sampling for new Sellers;
- higher sampling for Sellers with passive-runtime outliers;
- higher sampling for expensive or slashable claims;
- lower sampling after recent clean audits.

Selection is Buyer-local and MUST NOT be advertised to the Seller.

### Request Construction

For KBF, the verifier batches probes by domain. Each batch becomes a normal
upstream-compatible HTTP request. Example for OpenAI-compatible chat:

```jsonc
{
  "model": "gpt-5.4",
  "messages": [
    {
      "role": "system",
      "content": "Follow the user's instructions exactly. Output only what is requested."
    },
    {
      "role": "user",
      "content": "TASK: ...\n\n(1) ...\n(2) ..."
    }
  ],
  "temperature": 0,
  "max_tokens": 800
}
```

The Buyer MAY apply protocol adapters for OpenAI Chat, OpenAI Responses,
Anthropic Messages, or future formats. The adapter belongs in the verifier
package only if it is transport-agnostic. Actual sending belongs in
`@antseed/node`.

### ResponseAuth Requirement

The underlying `ResponseAuth` mechanism is implemented for normal Buyer/Seller
requests when both peers support `verification.response-auth.v1`. The fingerprint
audit runner is not implemented yet, but when it is, every audit request MUST
require a valid `ResponseAuth` before its response can enter a verifier result.
Missing or invalid auth produces:

```text
auditProbeStatus = "unauthenticated"
```

Unauthenticated probes do not count as model mismatches. They count as Seller
non-cooperation for routing/reputation policy.

### Evidence Sampling

Random buyer-side evidence sampling is implemented today for verified
`ResponseAuth` records. Audit-specific forced sampling is not implemented yet.
When fingerprint audits are added, audit requests SHOULD be stored even if the
normal random verification sampler would skip them. The sample directory format
remains:

```text
<dataDir>/verification_samples/
  <sellerPeerId>/
    <sampleId>/
      manifest.json
      request.bin
      response.bin
```

The audit result stores the `sampleId` for each probe batch. It does not duplicate
request or response bytes.

### Audit Result Schema

```jsonc
{
  "version": 1,
  "auditId": "sha256:...",
  "verifier": {
    "kind": "kbf",
    "package": "@antseed/fingerprints",
    "version": "0.1.0"
  },
  "sellerPeerId": "0x...",
  "advertisedService": "gpt-5.4",
  "referenceId": "sha256:...",
  "referenceModel": "openai/gpt-5.4",
  "startedAt": "2026-06-14T00:00:00.000Z",
  "completedAt": "2026-06-14T00:05:00.000Z",
  "probeCount": 224,
  "authenticatedProbeCount": 224,
  "parsedProbeCount": 220,
  "matchVectorHash": "sha256:...",
  "stats": {
    "selfHamming": 3,
    "selfTotal": 224,
    "targetHamming": 40,
    "targetTotal": 220,
    "selfCoverage": 1.0,
    "targetCoverage": 0.9821,
    "p0Cp99": 0.0634,
    "pValueBinomial": 0.00001
  },
  "verdict": "SAME | DIFF | UNDETERMINED | UNKNOWN",
  "verdictReason": null,
  "samples": [
    {
      "batchId": "chemistry_mp:0001",
      "requestId": "req-...",
      "sampleId": "req-...-abcd",
      "responseAuthRequestHash": "0x...",
      "responseAuthResponseHash": "0x..."
    }
  ]
}
```

`auditId` MUST be a content hash over the canonical audit result excluding local
paths. This lets arbiters and Buyers refer to the same exhibit without trusting a
database row ID.

### Local Routing Policy

Buyer-local policy MAY act immediately:

- `SAME`: no action; optionally reduce audit frequency for this Seller/service.
- `UNDETERMINED`: increase coverage or mark reference as weak.
- `UNKNOWN`: reference is invalid for enforcement; do not penalize Seller.
- `DIFF`: remove Seller from local routing for this service and persist the audit
  result.
- repeated unauthenticated audit probes: downgrade trust tier.

Local routing does not require consensus and does not slash.

---

## Reference Growth and Rotation

References are living data. They decay as models improve, facts become common in
training data, public probes leak, or serving behavior changes.

Reference maintenance rules:

- Public references are for reproducibility and smoke tests.
- Private references are for production enforcement.
- Buyers SHOULD rotate private KBF references periodically.
- Buyers SHOULD maintain at least two independent private references for
  expensive/slashable services.
- References SHOULD record the contrast models and generation method used.
- References SHOULD be re-self-tested after major upstream model updates.
- A reference with high self-error or low self-coverage MUST NOT be used for
  adverse action.
- A reference whose probes are answered perfectly by multiple strong contrast
  models SHOULD be marked stale.

Growing references is both a local Buyer capability and a network capability.
From day one, Antseed SHOULD support public signed fingerprint packs so the
network can accumulate shared model fingerprints over time. Private Buyer
references remain local and SHOULD NOT be published. On-chain storage of probe
files is explicitly out of scope. Storing probes on-chain makes them public,
expensive, and easy for Sellers to route around.

---

## Verification Flow

The end-to-end flow combines the mechanisms. Note what is continuous, what is
sampled, and what is rare:

**Every request (100%):**

1. Buyer → Seller request; Seller → response; Seller also sends `ResponseAuth`
   when both peers negotiated `verification.response-auth.v1` (M3).
2. Buyer verifies `responseAuth` recovers to the Seller's PeerId and stores the
   auth payload in verification storage. If no auth arrives, Buyer logs missing
   evidence rather than failing the HTTP response.
3. Buyer may store full request/response bytes in the verification sample
   directory according to local sampling policy.
4. Buyer updates passive fingerprint statistics (M4).

**Sampled request (`p`, Seller cannot tell which):**

5. Buyer additionally queries the reference and stores both signed responses
   locally (M2).

**Accumulation (per Seller, ongoing, Buyer-local):**

6. Once `N` samples exist, Buyer runs the distributional test (M2). Pass →
   discard. Fail → flag the Seller.

**Local enforcement (immediate, no consensus needed):**

7. A flagged Seller is dropped from this Buyer's `selectPeer()` candidate pool.
   This is the Buyer's own routing choice and requires no external agreement.

**Escalation (rare; only on a flagged, signed Seller):**

8. If the Buyer seeks on-chain consequences, it assembles an **evidence exhibit**:
   the signed sample set plus the corresponding reference responses.
9. The exhibit is submitted to a dispute path. Raw request/response bytes leave
   the Buyer **only at this step** and go to the arbiter, not to any public feed.
   On-chain, only a commitment (a hash of the exhibit) need be stored; the bytes
   may live off-chain and be revealed during adjudication.
10. The arbiter does not trust the Buyer. It (a) verifies every `responseAuth`
   mechanically — proving the samples are genuinely the Seller's — and (b)
   re-runs the test, or better, re-queries the accused Seller and the reference
   itself with fresh requests, since a real substitution reproduces over fresh
   samples while a fabricated accusation does not. On confirmation, the swappable
   slashing contract (`AntseedSlashing`) burns the Seller's stake.

---

## Slashing Roadmap

Fingerprinting is probabilistic. On-chain contracts MUST NOT slash directly from
a Buyer-local verifier result. The on-chain role is to accept a compact,
verifier-signed outcome after an off-chain dispute process has checked the
evidence.

### Slashable Claim

A Seller can make a slashable model-identity claim by advertising or registering
a policy commitment:

```jsonc
{
  "claimType": "model_identity",
  "service": "gpt-5.4",
  "referencePolicy": "sha256:...",
  "acceptedVerifiers": ["kbf", "behavioral-classifier"],
  "minCoverage": 0.8,
  "alpha": 0.05,
  "stakeSubjectToSlash": "100000000"
}
```

The claim says: "I am willing to be penalized if independent verification shows
that this service is statistically inconsistent with the claimed reference under
this policy." It does not require the Seller to know the Buyer's private probes.

### Commit-Reveal for Adverse Audits

If private probes can lead to slashing, the Buyer MUST be unable to choose only
bad probes after seeing responses. Use commit-reveal:

1. Before sending audit requests, Buyer computes:

   ```text
   probeSetCommitment = sha256(referenceId || verifierKind || orderedProbeIds || nonce)
   ```

2. Buyer records the commitment locally and MAY submit it to a cheap timestamping
   or dispute-intent path when the audit starts.
3. Buyer sends the ordered probe set through normal request flow.
4. After responses, Buyer reveals `orderedProbeIds` and `nonce` inside the
   evidence exhibit.
5. Arbiter verifies that the revealed probes match the pre-response commitment.

For local routing, commit-reveal is optional. For slashing, it is mandatory.

### Evidence Exhibit

An exhibit is off-chain data addressed to an arbiter or verifier committee:

```jsonc
{
  "version": 1,
  "claim": { "sellerPeerId": "0x...", "service": "gpt-5.4" },
  "auditId": "sha256:...",
  "probeSetCommitment": "sha256:...",
  "reference": { "referenceId": "sha256:...", "bytesHash": "sha256:..." },
  "auditResult": { "bytesHash": "sha256:..." },
  "samples": [
    {
      "requestBytesHash": "0x...",
      "responseBytesHash": "0x...",
      "responseAuth": {},
      "requestBytes": "<off-chain bytes>",
      "responseBytes": "<off-chain bytes>"
    }
  ]
}
```

The arbiter verifies:

- every `ResponseAuth` signature recovers to the Seller PeerId;
- every signed request hash matches the supplied request bytes;
- every signed response hash matches the supplied response bytes;
- every request occurred after the probe-set commitment;
- the audit result recomputes from the reference and samples;
- coverage thresholds are met;
- the verdict is `DIFF` under the registered policy.

### On-Chain Slash Signal

The slashing contract receives only a compact outcome:

```jsonc
{
  "seller": "0x...",
  "service": "gpt-5.4",
  "claimHash": "bytes32",
  "auditBundleHash": "bytes32",
  "verdict": "DIFF",
  "verifierSet": "bytes32",
  "signatures": ["0x..."],
  "deadline": 1790000000
}
```

Raw prompts, completions, and probe files do not go on-chain. The contract checks
the verifier signatures and applies the slash policy for `claimHash`.

Recommended enforcement ladder:

- single local `DIFF`: Buyer routing downgrade;
- repeated independent local `DIFF`: reputation warning and increased sampling;
- arbiter-confirmed `DIFF` against a slashable claim: stake slash;
- missing `ResponseAuth` on audit traffic: non-cooperation penalty, not
  model-fraud slashing by itself.

---

## Privacy

Verification MUST NOT broadcast Buyer traffic. Real prompts and completions are
sensitive. Accordingly:

- M2 samples are stored Buyer-locally and discarded on a pass.
- Raw bytes leave the Buyer only inside a dispute exhibit, addressed to an
  arbiter, and only for a Seller already flagged.
- On-chain artifacts are commitments (hashes), never plaintext.

---

## Abuse Resistance (malicious Buyer)

Signed responses (M3) make the Seller non-repudiable, which neutralizes the
naive forge-evidence attack: a Buyer cannot invent a signed response. The
residual attack is **selective omission** — a Buyer presenting only unfavorable
samples. This is countered by requiring the exhibit's sample set to reconcile
against the Buyer's metered request history (already retained for billing per
[03-metering.md](./03-metering.md)) and by the arbiter's own fresh re-query in
step 9, which does not depend on the Buyer's samples at all.

---

## Parameters

| Parameter | Symbol | Default | Notes |
|---|---|---|---|
| ResponseAuth wait grace | — | 30s | Implemented Buyer wait after response before logging missing auth |
| Verification sample rate | — | 0.005 | Implemented random full evidence sample rate for verified auths |
| Verification sample byte cap | — | 16 MiB | Implemented max encoded request + response bytes per sample |
| Sample rate | `p` | 0.02 | Fraction of real requests duplicated to reference (M2) |
| Min samples per verdict | `N` | 30 | Below this, no M2 verdict is emitted |
| Distributional fail threshold | — | tuned on real traffic | Drives *local* flagging only |
| Probe cadence (if M1 used) | — | 1 / 20 requests | M1 is deterrence/triage only |
| KBF batch size | — | 10 probes | One Antseed request per domain batch |
| KBF min coverage | — | 0.5 | Below this, verdict is `UNDETERMINED` |
| KBF CP confidence | — | 0.99 | Upper bound for reference self-error |
| KBF alpha | — | 0.05 | One-sided binomial threshold for `DIFF` |
| Audit sample retention | — | always for audit probes | Audit probes bypass random sample-rate skipping |

Thresholds that affect **local** routing may be liberal. Thresholds that gate
**on-chain** penalties MUST be conservative and are ultimately the arbiter's
decision in step 9, not a Buyer-side constant.

---

## Implementation Milestones

Completed milestones:

1. ResponseAuth substrate:
   - protocol type and codec;
   - `VerificationMux`;
   - capability-gated Seller sending;
   - Buyer verification;
   - `verification.db` response-auth storage;
   - random verified request/response evidence samples.

The next implementation SHOULD proceed in small PRs with clean package
boundaries:

1. `@antseed/fingerprints` pure package:
   - shared `FingerprintVerifier` interface;
   - schema types for references, fingerprint packs, probes, match vectors, and
     results;
   - canonical JSON hash helper;
   - verifier registry;
   - public pack import/export helpers;
   - KBF verifier module;
   - numeric parser;
   - tolerance matcher;
   - CP99 and binomial functions;
   - verdict computation;
   - unit tests with small fixture references.

2. Fingerprint swarm support:
   - define pack signing bytes;
   - validate publisher signatures;
   - announce pack metadata on fingerprint swarm topics;
   - fetch packs from peers and mirrors by content hash;
   - seed verified packs for other peers;
   - verify `packId`;
   - import trusted references into local storage;
   - expose pack trust/staleness metadata.

3. Buyer-local reference store in `@antseed/node`:
   - import public/generated references;
   - validate schema;
   - compute and verify `referenceId`;
   - write under `<dataDir>/fingerprints/references/<referenceId>.json`;
   - list references by `serviceAliases`.

4. KBF audit runner in `@antseed/node`:
   - select Seller/service/reference;
   - construct KBF request batches;
   - send through the ordinary Buyer request path;
   - require verified `ResponseAuth`;
   - force-store audit request/response samples;
   - call `@antseed/fingerprints` to compute the verdict;
   - write `<dataDir>/fingerprints/audits/<sellerPeerId>/<auditId>.json`.

5. Local routing integration:
   - avoid Sellers with recent `DIFF` for the requested service;
   - increase audit rate for `UNDETERMINED` or unauthenticated probes;
   - surface audit status in diagnostics without broadcasting raw prompts.

6. Additional fingerprint families:
   - add behavioral-classifier, perturbation, rare-token, instruction-hierarchy,
     output-distribution, runtime, and passive proxy-reader verifier modules
     behind the day-one `FingerprintVerifier` interface;
   - keep each verifier module transport-agnostic;
   - reuse the same reference store, sample store, and audit-result schema.

7. Dispute/slashing prototype:
   - add probe-set commitment support;
   - build an off-chain exhibit verifier;
   - define verifier committee signatures;
   - add compact slash signal support to `AntseedSlashing`.

Do not start with slashing. Slashing depends on mature evidence format,
commit-reveal, reproducible verifier code, and independent adjudication.

---

## Relationship to Other Layers

- **Reputation ([05](./05-reputation.md)):** a confirmed substitution is the kind
  of signal the future ERC-8004 `Accuracy` path could carry — but only after
  arbiter confirmation (step 9), never directly from an M1/M2 fail verdict.
- **Metering ([03](./03-metering.md)):** carries `responseAuth` (M3) and the
  retained request history used for abuse resistance. Audit requests are normal
  paid requests unless the Buyer and Seller later agree on a separate audit
  accounting policy.
- **Security ([06](./06-security-overview.md)):** model substitution is a
  trust-boundary violation between Buyer and Seller; this document is the
  cross-reference for that residual risk.
- **Transport ([02](./02-transport.md)):** fingerprint requests use ordinary
  request/response framing. No verifier-specific frame type is required for
  fingerprint audits.
- **Fingerprint Swarm ([08](./08-fingerprint-swarm.md)):** distributes public
  fingerprint packs by content hash. Model verification imports trusted packs
  from the swarm, then runs Buyer-local audits and stores signed evidence.

---

## Summary

| Mechanism | Cost | Detects | Drives penalties? |
|---|---|---|---|
| M1 Behavioral probes | very low | tier mismatch, lazy substitution | No (deterrence/triage) |
| M2 Reference shadow sampling | ~`p` of spend | family substitution, quantization | Local routing; on-chain only via M3 exhibit |
| M3 Signed responses | negligible | nothing alone — enables M2 evidence | Yes, as exhibit input |
| M4 Passive fingerprinting | free | gross outliers | No (triage) |
| M5 TEE attestation | premium | proves served endpoint/weights | Authoritative |
| F1 KBF | low to medium | knowledge-boundary mismatch | Local routing; slashing only after dispute |
| F2-F9 Fingerprint suite | variable | behavioral/runtime/provenance/model-family mismatch | Local routing and triage unless independently confirmed |

The implemented base is **M3 ResponseAuth + buyer-side verification storage +
random verified evidence samples**. The recommended next implementation is
**`@antseed/fingerprints` + public fingerprint packs + buyer-local audit
storage**: implement the shared fingerprint package with KBF as the first
verifier, publish and mirror signed public fingerprint packs, store trusted
references by content hash, run Buyer-side audits through the normal request
path, and persist auditable manifests that point to signed request/response
samples. M2 remains the stronger long-term distributional check for real
traffic; F2-F9 expand the suite through the same package and public fingerprint
swarm. On-chain slashing comes last.
