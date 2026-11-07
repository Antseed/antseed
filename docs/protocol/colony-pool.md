# Colony pools

A colony pool is one Antseed seller that serves buyers from many worker
machines (for example Macs running local models). Workers dial the pool; the
pool stakes, holds the payment channels and settles. Three mechanisms keep the
split honest without trusting the pool operator:

1. **End-to-end encryption.** The buyer encrypts each request to the worker's
   key, and the worker encrypts its response to the buyer. The pool routes
   ciphertext and cannot read prompts or forge which worker answered.
2. **Buyer-signed attribution.** The buyer appends each worker's cumulative
   amount to the metadata it already signs in every SpendingAuth.
3. **On-chain split.** `AntseedColonyPool` settles through the same
   `settle`/`close`/`topUp` calls as any seller façade, reads the attribution
   from the buyer-signed metadata, and credits each worker its share of the
   USDC payout and of the pool's ANTS emissions. Workers (or the payout
   wallets they link) claim directly.

What still requires trust: the operator decides routing (it can starve a
worker, which then leaves), an operator colluding with a buyer is wash
trading, handled like any other seller, and the worker's machine decrypts the
prompt. [Hardened Macs](#hardened-macs) keep the machine's owner out of it.
That protection is weaker than a TEE.

## Keys

Each worker has:

- a **secp256k1 identity** — its address, used to sign and to receive payouts;
- a **static P-256 encryption key** (P-256 so a Mac can keep it in the
  Secure Enclave);
- optionally, a **P-256 attestation key** that signs
  [attestations](#hardened-macs).

Public keys travel as uncompressed SEC1 points (`04 ‖ x ‖ y`, 65 bytes,
lowercase hex). The worker binds them to its identity with a **key
certificate**, an EIP-191 signature by its identity over:

```
antseed-worker-key/v2
pool:<pool seller address, lowercase hex>
key:<encryption public key>
expires:<unix seconds>
attestation-key:<attestation public key, or empty>
```

## Assignment

Pools advertise the peer capability `colony-pool-e2e.v2`, and
`colony-pool-e2e.v2.<provider>` for the provider that serves through workers.
Whether a request is encrypted to a worker follows the provider it names
first: a request naming a colony-pool provider is always encrypted, even when
the buyer's view of the pool's models is out of date. A request naming an
ordinary provider stays plaintext only when that provider offers the model,
since otherwise the seller would serve it through another provider, possibly
its pool. Without a named provider, the provider the buyer routes it to
decides, and a model no provider offers is encrypted. The assignment request
names the pool the request is for, and buyers cache one assignment per
seller, provider and service. One case only the seller can see remains: if a
seller stops offering a model on an ordinary provider while the buyer's
metadata still lists it there, the seller could route that plaintext request
to its pool (which refuses it with `428`, after the seller has seen it). Before its first request for a pool service, the buyer
asks the pool for its top-ranked workers:

```
POST /_antseed/provider/colony-pool/assign
{ "model": "<service>", "recipients": 2 }

200 { "workers": [
  { "worker": "0x…", "key": "04…", "expires": <unix>, "certificate": "0x<sig>", "pool": "0x…",
    "attestationKey": "04…", "attestation": { … } },
  …
] }
```

`recipients` is the node option `colonyPoolRecipients`: 1 to 3, default 2.
The pool returns up to that many distinct workers, best-ranked first (see
[Routing and failover](#routing-and-failover)). For each one the buyer checks
that the certificate recovers to `worker`, that `pool` is the seller it is
paying, and that it has not expired. When an attestation is present it must
verify (see [Hardened Macs](#hardened-macs)); a buyer configured with
`requireAttestedWorkers` or `requireAppleVerifiedWorkers` also applies that
policy. A worker that fails any check is left out of the set, and the buyer
refuses the assignment only when no worker is left. It keeps the set per
(seller, provider, service) until the first of its certificates or
attestations stops being usable, or the pool answers `421` with
`{"error":{"code":"worker_unavailable"}}`, then reassigns and retries once.
Paths under `/_antseed/provider/` are free control routes: the seller hands
them to the provider serving the body's `model` (`Provider.handleControlRequest`)
without payment or metering, rate limited per buyer. A pool refuses plaintext
buyer requests with `428` `{"error":{"code":"e2e_required"}}`; it seals the
seller's own health probes to a worker itself.

## Request envelope

The buyer encrypts the body once, for every worker in its assignment, and
replaces the request body with:

```json
{
  "model": "<service>",
  "stream": true,
  "max_tokens": 1024,
  "antseed_e2e": {
    "v": 2,
    "recipients": [
      { "worker": "0x…", "epk": "<base64 uncompressed P-256 ephemeral public key>", "wk": "<base64 wrapped content key>" },
      { "worker": "0x…", "epk": "…", "wk": "…" }
    ],
    "ct": "<base64 ChaCha20-Poly1305 ciphertext of the original JSON body>",
    "buyer": "0x…",
    "channel": "0x…",
    "sig": "0x…"
  }
}
```

`model`, `stream` and `max_tokens` stay in the clear for routing, streaming
and budget checks. Everything else is in `ct`. `recipients` lists 1 to 3
distinct workers, in the order the pool assigned them.

Key schedule, per request (a fresh content key and a fresh ephemeral key per
recipient every time). `list` is the recipients' addresses, lowercase, joined
by commas, in envelope order:

```
contentKey = 32 random bytes
ct         = ChaCha20-Poly1305(contentKey, nonce = 12 zero bytes, aad = "antseed-worker-e2e/v2|req|" ‖ list ‖ "|" ‖ model)

for each recipient i (worker key Wᵢ, fresh ephemeral key eᵢ):
  sharedᵢ  = ECDH-P256(eᵢ, Wᵢ)   (the x-coordinate, 32 bytes)
  okmᵢ     = HKDF-SHA256(ikm = sharedᵢ, salt = epkᵢ ‖ Wᵢ, info = "antseed-worker-e2e/v2", length = 64)
  wrapKeyᵢ = okmᵢ[0:32]
  respKeyᵢ = okmᵢ[32:64]
  wkᵢ      = ChaCha20-Poly1305(wrapKeyᵢ, nonce = 12 zero bytes, aad = "antseed-worker-e2e/v2|wrap|" ‖ list ‖ "|" ‖ model, contentKey)
```

A worker finds its own entry, unwraps `contentKey` with its own ECDH secret,
and opens `ct`. It rejects the request unless it is named in `recipients`
(exactly once), and unless the inner body's `model` equals the outer `model`
(the AADs already bind it and the recipient list: reordering, dropping or
adding a recipient makes the request fail to open).

`sig` is the buyer's EIP-191 signature over
`keccak256("antseed-worker-e2e/v2" ‖ worker₁ ‖ … ‖ workerₙ ‖ channel ‖ keccak256(ct))`
(addresses as 20 bytes in envelope order, `channel` as 32 bytes). It proves the
request came from a buyer of this pool, for exactly this set of workers, so an
operator cannot feed a worker requests of its own and relay the results to a
buyer under a different key. A worker that checks the chain verifies that
`channel` belongs to `buyer` and to the pool seller.

**Privacy with several recipients.** Any of the N recipient Macs could
decrypt the request if the pool forwards it to them. The pool forwards to one
at a time, in rank order, and only within the set the buyer signed (see
[Routing and failover](#routing-and-failover)); set `colonyPoolRecipients` to
1 so only one Mac can ever read a request.

## Response envelope

Each recipient answers under its own key. The worker picks a random 16-byte
`salt` and seals with

```
responseKey = HKDF-SHA256(ikm = respKeyᵢ, salt = salt, info = "antseed-worker-e2e/v2|resp-key", length = 32)
```

so a replayed request (same `epkᵢ`, same `respKeyᵢ`) never reuses a key and
nonce pair for a different answer, and no recipient can produce an answer
under another recipient's key.

Non-streaming: the worker answers

```json
{ "antseed_e2e": { "v": 2, "worker": "0x…", "salt": "<base64>", "ct": "<base64>" }, "usage": { … } }
```

where `worker` is the answering worker and `ct` is the upstream body sealed
with `responseKey`, nonce 0, AAD `"antseed-worker-e2e/v2|resp|0|end"`.

Streaming: each upstream SSE event `data: X` becomes

```
data: {"antseed_e2e":{"seq":n,"ct":"<base64>"}}
```

sealed with `responseKey`, nonce = `seq` as a 96-bit big-endian counter starting
at 0, AAD `"antseed-worker-e2e/v2|resp|<seq>"`. The `seq` 0 event also carries
`"worker"` and `"salt"`. The last event sets
`"end":true` and uses AAD `"antseed-worker-e2e/v2|resp|<seq>|end"`, so a
truncated stream fails to verify.

The buyer opens the answer with the response key of the worker it names, and
only of a worker the request was encrypted for. A label naming another
recipient fails to open (only the named worker holds that key), and a label
naming any other worker is refused.

In both cases the worker also emits the upstream `usage` in the clear (as the
`usage` field, or as one plain `data: {"choices":[],"usage":{…}}` event before
the final encrypted event) so the seller can meter. The buyer fails a response
whose clear usage differs from the usage inside the ciphertext, or that does
not verify. For a stream that includes one that ends without the
authenticated end marker or that is not SSE: the client gets a stream error
instead of a clean end, even though earlier events already reached it.

The buyer attributes a request to the recipient whose sealed answer verified:
only a recipient can decrypt the request, and only the one that answered can
seal under its response key.

## Workers

- A worker serves only sealed requests addressed to it.
- A request without a valid buyer binding (or bound to the zero channel) is
  treated as the pool's own check: its decrypted body is limited to 8 KiB (and
  2,048 prompt tokens in the Mac app), `max_tokens` is capped at 16 and checks
  are rate limited per hour, so a pool cannot buy real work with them.
- A worker runs at most the `maxConcurrency` it announces, counting requests
  still waiting on a channel check, and refuses extras ("Worker is at
  capacity"). A request cancelled or disconnected while it waits never starts.
  The pool runs its join checks one at a time, each in a free slot.
- The pool sends each request to a worker under its own dispatch ID, so two
  buyers using the same request ID never collide, in delivery or in the
  worker's earnings. It pings workers every 15
  seconds (`heartbeatIntervalMs`) and disconnects one that misses two pings in
  a row; a worker reconnects when it hears nothing from the pool for 45
  seconds (`poolSilenceMs`).
- A started response that sends nothing for 60 seconds
  (`responseIdleTimeoutMs`) is cancelled and the worker frees its slot. A
  worker may send at most 64 MiB per response, and 1 MiB answering the pool's
  own checks. The reference worker gives its local model 5 minutes to start
  answering and 60 seconds per chunk after that.
- Workers check channels only on the AntseedChannels contract of their own
  chain config, never one the pool names: `antseed-pool-worker --chain-id`
  (default base-mainnet) or `--channels-address`; the Mac app uses the
  deployment for its RPC's chain (Base mainnet and Base Sepolia built in) or
  `--channels`, generated from the deployment records by
  `scripts/generate-contract-chain-config.mjs`), and with an RPC but no
  trusted contract refuses buyers' requests.
- With an RPC endpoint, a worker serves a bound request in full only on a
  verified channel: an **Active** channel (status 1 in AntseedChannels
  `channels(bytes32)`; a settled or timed-out channel keeps its buyer and
  seller but is refused) that the chain shows belongs to the signing buyer and
  to the pool seller. A verification lasts 60 seconds
  (`verifiedChannelTtlMs`), then the channel is checked again, so one closed
  since stops getting full requests; refusals are final, and verdicts are kept
  per pool seller. A channel that belongs to someone else is refused (cached
  for that buyer), and once a channel is verified for one buyer every other
  signer naming it is refused without another lookup. A channel not on-chain
  yet is looked up every second for up to 5 seconds (a fresh reserve can lag
  the RPC; requests waiting on it share one lookup, each read with a short
  deadline), then refused with a retryable error. So a pool cannot buy real
  work by signing bindings to channels that don't exist. There is no
  signature-only mode: a worker without a channel verifier or an RPC refuses
  buyer requests and runs only the pool's checks. `antseed-pool-worker`
  reads the `--chain-id` chain's public RPC unless `--rpc-url` names another;
  the Mac app uses Base mainnet's public RPC (generated from chain-config)
  unless `--rpc` names another.

## Routing and failover

The pool assigns each buyer the best-ranked workers for the model that have a
free slot (as many as it asks for, up to 3). A worker's score is its operator weight × its reliability (the
smoothed share of buyer requests it answered) × its decode speed relative to
the fastest worker for that model, divided by 1 + its load. A worker with no
record yet gets the others' average reliability and speed, so it is neither
punished nor favored.

A worker that fails a request it is responsible for (it never answered in
time, or dropped its connection before answering) is **benched**: no
assignments or dispatches for 30 seconds, doubling with each failure in a row
up to 10 minutes, and cleared by its next answered request. A response that
goes silent midway, or exceeds its byte limit, lowers its reliability without
benching it. A worker's error counts against it only after it sent
`accepted` (its model failed or timed out); refusals before that (channel,
binding, capacity, check limits) never do, so buyers can't lower a Mac's rank
with bad requests. Ranks, including each worker's smoothed decode speed (learned only
from streamed answers: a buffered answer arrives in one burst after
generation, so it adds no speed sample), survive reconnects and pool restarts (the ledger keeps them
in `worker_rank`, and each outcome in `dispatches` for 30 days), so a flaky
Mac can't reset its record by reconnecting.

The pool sends a buyer's request to the best-ranked of its recipients that can
take it now. When that worker fails before any byte reached the buyer (it
never picked the request up, did not answer in time, disconnected, refused it,
or is benched), the pool sends the same envelope to the next recipient, with
no round trip to the buyer. It never sends it to a worker outside the set the
buyer signed, and never to two workers at once; each attempt counts toward its
own worker's rank. Once every recipient has failed, the pool answers
`421 worker_unavailable` and the buyer takes new workers once, re-encrypting
the request for them. A failed attempt is never paid for.

Every worker sends `{"t":"accepted","id":…}` once it has admitted a request
and its channel check passed, before inference, and must do so within
20 seconds (`acceptTimeoutMs`); it then has 120 seconds to start answering
(`firstByteTimeoutMs`). So a stuck worker is failed over quickly, while a slow
non-streamed answer still gets the full 120 seconds. A failure after the
response started reaches the client as a stream error.

`COLONY_POOL_WORKER_PRIORITY` (`0xaddress=weight,…`, default 1) multiplies a
worker's score: 2 doubles it, 0 means the pool never routes to it (its models
are not announced through it). The seller dashboard's **Workers** panel lists
workers in this order (Rank, from the same score inputs the pool routes by), with each one's share of requests answered over
24 hours and 7 days, median time to first byte, and how long a benched worker
has left.

## Payment for pool requests

Buyers pay for a pool request only after the worker's sealed answer verifies,
and only up to what the worker's sealed usage costs: every billed count
(input, fresh input, cached input, output) must be within the sealed one, and
the token cost may not exceed the cost of the sealed usage, with no estimate
tolerance. A NeedAuth for a request whose answer is tampered with, truncated
or missing is refused. Per-request authorizations are priced from the sealed
usage. A buyer never forgets that a request went to a worker: when its cache
of unpaid worker requests is full, the oldest one's ID is kept and a later
payment request naming it is refused (past 16,384 such IDs for one seller,
the buyer sends that seller no more worker requests), and a payment request
from a different seller naming a worker request is refused.

A buyer pays a colony-pool seller only for requests it sent that seller: a
delivered-cost NeedAuth that names no request, or one the buyer never sent it,
is refused, so a pool can't turn a failed worker answer into an ordinary
claim. Requests to the same seller's ordinary providers are tracked and paid
as usual. A pool seller's own headroom prompts never reopen the buyer's
overdraft window; beyond the one prepaid request, it is paid only for answers
whose worker seal verified. A worker request whose answer verified but whose
cost was only partly signed (capped at the reserve ceiling) is kept, with its
worker and sealed usage, until the remainder is signed; past 4,096 such
requests to one seller the buyer sends that seller no more worker requests
until its reserve grows.

A request routed to a colony-pool provider is encrypted to its workers or not
sent at all: a client without worker encryption, such as the web SDK, fails
it locally before any bytes go to the seller.

Workers are paid through the buyer's signed attribution. A pool operator who
opens a real channel as a buyer could have workers serve requests it then
never pays through that channel; the channel check proves a buyer exists, not
that it will pay.

## Hardened Macs

The Antseed Mac app runs models on the bundled TensorFold engine, a separate
process it reaches over loopback. The decrypted prompt therefore leaves the app:
the Mac's owner can read loopback traffic, and the app's protections below
don't cover the engine. **Every current build attests `debuggerDenied: false`,
so it is not hardened**, and pools and buyers that require attestation refuse
it. The rest of this section describes what the app enforces and what a build
that keeps inference inside the app would attest.

With inference in the app, the decrypted prompt exists only in its memory. The
app keeps the Mac's owner out of it with the protections macOS gives a signed
app, and reports them in an attestation:

- **Signed app with the hardened runtime.** A Developer ID build with the
  hardened runtime and without `get-task-allow`: macOS refuses to let other
  processes, root included, attach a debugger or inject code. The app also
  calls `ptrace(PT_DENY_ATTACH)` at launch.
- **SIP on.** System Integrity Protection is what makes macOS enforce those
  rules. Turning it off needs a reboot into Recovery. A signed app checks SIP
  at launch and on every attestation, and stops serving when it is off.
- **Secure Enclave keys bound to the app.** The decryption and attestation keys
  are created in the Secure Enclave and can't be exported. Their handles are
  stored in the data-protection keychain under the app's access group, so only
  apps signed by that team with that identifier can use them. A build without
  that entitlement keeps the handles in a file and reports
  `keyAppBound: false`.

Attestations travel in `hello` and answer the pool's challenge nonce:

```json
{
  "v": 1, "teamId": "H3M5BXXQR2", "signingId": "com.antseed.macworker", "cdhash": "<hex>",
  "sip": true, "hardenedRuntime": true, "debuggerDenied": true, "keyAppBound": true,
  "os": "macOS 26.2", "serial": "<serial number>", "udid": "<hardware UUID>",
  "issued": <unix>, "nonce": "<challenge nonce>",
  "signature": "<base64 DER ECDSA-P256-SHA256 by the attestation key>"
}
```

The signature covers:

```
antseed-worker-attestation/v1
worker:<address>
key:<encryption key>
team:<teamId or empty>
signing-id:<signingId or empty>
cdhash:<cdhash or empty>
sip:<1|0>
hardened-runtime:<1|0>
debugger-denied:<1|0>
key-app-bound:<1|0>
os:<os>
serial:<serial or empty>
udid:<udid or empty>
issued:<unix>
nonce:<nonce>
```

An attestation is **valid** when it verifies under the certificate's
`attestationKey` and is fresh. It is **hardened** when it is also signed by a
team (`teamId` set) and every flag is 1. The pool re-challenges attested
workers every 5 minutes with an `attest` frame (`{"t":"attest","nonce":…}`,
answered by `{"t":"attestation","attestation":…}` within 30 s) and disconnects
a worker that does not answer, sends an invalid attestation, or stops
reporting hardened. It hands buyers the latest attestation with each
assignment. Buyers check it themselves, accepting one up to 15 minutes old.
Because the attestation key is certified by the worker's identity, the pool
cannot forge an attestation or move one to another worker.

Pool settings: `COLONY_POOL_REQUIRE_ATTESTATION` admits only hardened workers,
and `COLONY_POOL_ATTESTED_TEAMS` limits which Apple Developer teams count.

**Limits.** This is a hardened Mac, not a TEE. Memory is not encrypted, so a
kernel exploit, or a gap in macOS's enforcement, exposes prompts. The
attestation is self-reported: it proves that the app holding the
Secure Enclave key reports a signed build with SIP on. Apple does not vouch
for it, so a modified app that generates its own keys could claim the same.
[Apple-verified Macs](#apple-verified-macs) add Apple's own word for the
device and its SIP state.

## Apple-verified Macs

Optionally, a pool operator runs their own MDM server and the Mac owners who
want the higher level enroll their Macs in it. Antseed runs no MDM. The pool
then gets an **Apple Managed Device Attestation** for each enrolled Mac: a
certificate chain signed by the Apple Enterprise Attestation Root CA that
states the Mac's serial number, OS version and SIP status, and that answers a
nonce naming the worker and its attestation key.

1. The worker's signed attestation names its Mac (`serial`, `udid`).
2. The pool asks its MDM to send that Mac a `DeviceInformation` command
   querying `DevicePropertiesAttestation`, with
   `DeviceAttestationNonce = sha256("antseed-device-attestation/v1\n" ‖ worker ‖ "\n" ‖ attestationKey ‖ "\n" ‖ challenge)`,
   where `challenge = hex(sha256("antseed-device-challenge/v1\n" ‖ worker ‖ "\n" ‖ attestationKey ‖ "\n" ‖ udid))`.
   The challenge is derived, not random: Apple issues a new attestation for a
   device at most once every 7 days and returns the cached one in between,
   whatever nonce is sent, so the cached one must still answer it, also after
   the worker reconnects or the pool restarts. Freshness comes from the
   leaf's issue time.
3. It verifies that the chain leads to Apple's root, that the freshness code
   (OID 1.2.840.113635.100.8.11.1) equals that nonce, that the serial number
   (…8.9.1) is the one the worker attested, that SIP (…8.13.1) is on, and
   that the leaf is at most 8 days old. The pool asks again once the
   attestation is 7 days old, then daily while Apple still returns it, and
   stops treating the Mac as Apple-verified once it is 8 days old.
4. Assignments carry `deviceAttestation: { chain, challenge }`. Buyers
   recompute the nonce from the worker, its certified attestation key and the
   challenge, and verify the chain themselves (accepting one up to 8 days old,
   and dropping a cached assignment when it passes that age or a certificate
   in the chain expires). A buyer with `requireAppleVerifiedWorkers` refuses workers without
   it.

Because the nonce names the worker and its attestation key, the pool can't
reuse one Mac's attestation for another worker. It also means a worker whose
attestation key changes (a reinstall, or keys created again) is not
Apple-verified until Apple issues its next attestation, up to 7 days later.

So "Apple-verified" means: Apple attested, within the last 8 days, that this
Mac had SIP on and that this worker and attestation key asked for the
attestation. Turning SIP off needs a reboot into Recovery; in between Apple's
attestations, it is the app's own attestation every 5 minutes (self-reported,
see Hardened Macs) that reports SIP, and the app stops serving when it is off.

Pool settings: `COLONY_POOL_MDM_URL`, `COLONY_POOL_MDM_API_KEY`,
`COLONY_POOL_MDM_WEBHOOK_PORT` and `COLONY_POOL_MDM_WEBHOOK_PATH` (required
with the MDM: at least 16 random characters, since the path is the webhook's
only secret; bodies over 64 KiB are refused) connect a
[NanoMDM](https://github.com/micromdm/nanomdm) server (commands are queued
with `PUT /v1/enqueue/<udid>`; answers arrive on its webhook, configured
with `-webhook-url http://<pool>:<port>/<path>`).
`COLONY_POOL_REQUIRE_DEVICE_ATTESTATION` routes only to Apple-verified Macs.
Other MDMs can implement the `DeviceAttestor` interface.

What the operator needs: an MDM server, an Apple MDM push certificate (it
needs an Apple Business Manager account or a vendor-signed request), and
Macs with Apple silicon on macOS 14 or later. Enrolling gives the operator
MDM powers over the Mac, which owners should weigh.

**Limits.** Apple vouches for the Mac and its SIP state, not for which app
holds the decryption key. An owner running a modified app, on the enrolled
Mac or on a second one, could still present the enrolled Mac's attestation.
Tying the key to the device needs the worker's attestation key to come from the MDM itself (an ACME
hardware-bound key, whose certificate Apple also attests), which this
version does not do yet. Prompts are still in unencrypted memory, as above.

## Attribution in SpendingAuth metadata

The buyer appends a worker block after the ABI-encoded metadata (v5). ABI
decoders read the head by offset and ignore trailing bytes, so existing
indexers are unaffected.

```
metadata = abi.encode(v5 fields…) ‖ entries ‖ uint8 count ‖ bytes32 WORKER_TAIL_MAGIC
entry    = address worker (20 bytes) ‖ uint128 cumulativeAmount (16 bytes, big-endian)
WORKER_TAIL_MAGIC = keccak256("antseed:worker-attribution:v1")
```

- At most 8 entries (`MAX_WORKERS_PER_CHANNEL`); the pool keeps a buyer on the
  same worker, which also helps prompt caching.
- Entries are sorted by worker address, with no duplicates or zero addresses.
- `cumulativeAmount` is the USDC (6 decimals) the buyer has paid on this
  channel for requests that worker served. Each entry only grows, and the sum
  never exceeds the SpendingAuth's `cumulativeAmount`.

## AntseedColonyPool contract

`AntseedColonyPool is AntseedSellerDelegation`. It keeps the façade ABI
unchanged, so seller nodes settle through it with no code changes.

On every `settle`, `close` and `topUp` (all `nonReentrant`, paused by
`pause()`):

1. Call the parent, which forwards to `AntseedChannels` (which verifies the
   buyer's signature over `keccak256(metadata)`), receives the USDC payout and
   takes the operator fee. The rest is `net`.
2. `delta` = the channel's new cumulative amount minus the last one this
   contract recorded.
3. If `delta` is 0, credit all of `net` to the remainder and leave worker
   cumulatives untouched: `AntseedChannels` skips the buyer-signature check on
   no-op `close`/`topUp` calls, so metadata on those paths is not
   buyer-authenticated and must not move any worker's high-water mark.
   Otherwise parse the worker block. If it is malformed, attribute nothing
   (never revert: a buyer must not be able to block settlement).
4. For each worker, `workerDelta` = its new cumulative amount minus the last
   recorded one (0 if lower), clamped so the sum stays ≤ `delta`.
5. Credit `net × workerDelta / delta` to each worker. The remainder
   (unattributed requests and rounding) goes to the owner-set
   `remainderRecipient`.
6. Add each credit to the worker's weight for the current emissions epoch.

Per-channel cursors are keyed by the channels contract address as well as the
channel ID, so a channels contract swapped in through the registry starts
clean. Credited USDC always equals `net`.

Emissions are claimed into the contract by anyone with
`claimEpochEmissions(epochs)`, only for finished epochs (weights are final
once an epoch ends). Each worker claims its share of an epoch's ANTS (after
the operator fee) in proportion to its weight; ANTS for an epoch with no
weight go to the remainder. Workers claim USDC with `claimUsdc()` and ANTS
with `claimAnts(epochs)`; pausing never blocks these claims.

The pool must own its ERC-8004 agent to be staked and to receive emissions.
The owner mints one for the pool with `registerAgent(agentURI)` (or transfers
one in) and, on the seller-registry stack, binds it with
`registerSeller(agentId)`, which the pool calls itself; ANTS stake for that
agent then makes the pool channel-eligible. On the legacy stack it is staked
with `staking.stakeFor(pool, agentId, amount)`. Settlements during the
emissions cutover add weight to the first rewarded epoch, matching the usage
accounting. On AntseedEmissionsV2, pulling emissions fails (`EmissionsLocked`)
while the pool's seller reward would be locked, leaving the epoch unclaimed
until the unlock policy lets the pool claim it. The buyer decides the split it signs; the contract enforces only
what the buyer signed.

### Payout wallet

A worker's key lives on its machine; its owner's wallet is usually elsewhere.
`setPayout(worker, payout, deadline, signature)` routes the worker's credits
to `payout`. Anyone may submit it; it is authorized only by the worker's
EIP-191 signature over the 32 bytes

```
keccak256(abi.encode(keccak256("antseed-worker-payout/v1"), chainid, pool, worker, payout, payoutNonce[worker], deadline))
```

(`payoutDigest(worker, payout, deadline)` returns it). The nonce increments
on each change, so a link cannot be replayed. Linking also moves what the
worker already earned: its unclaimed USDC, and its ANTS weight (with what it
already claimed) for the current epoch and the `MAX_EPOCHS_PER_CLAIM` before
it. Older ANTS shares stay claimable by the worker key.

The Antseed Mac app signs this and copies a link code,
`antseed-link:<base64url JSON {chainId, pool, worker, payout, deadline, signature}>`.
The owner pastes it in the ANTS dashboard (Rewards → Link a Mac), which checks
the chain and that the connected wallet is `payout`, submits `setPayout`, and
from then on shows the pool's USDC and ANTS owed to that wallet with a claim
button (linked pools are saved in `<data dir>/ants-activity/<chain>-colony-pools.json`). The Mac app keeps the signed link until the contract records it or
its deadline passes, so its code can be copied again after a restart, and
shows "Pays to" only for the wallet `payoutOf` returns; **Change wallet**
signs a new link. The seller dashboard shows the pool operator each worker's
status, speed, requests and earnings from the pool's ledger
(`<data dir>/colony-pool.db`, or the file `COLONY_POOL_LEDGER_PATH` names,
which the pool records in `<data dir>/colony-pool.ledger-path` for the
dashboard). A worker counts as online there only while the seller's heartbeat
is fresh; after a seller crash, open connections end at its last heartbeat.
