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

Pools advertise the peer capability `colony-pool-e2e.v2`. Before its first
request for a service, the buyer asks the pool for a worker:

```
POST /_antseed/provider/colony-pool/assign
{ "model": "<service>" }

200 { "worker": "0x…", "key": "04…", "expires": <unix>, "certificate": "0x<sig>", "pool": "0x…",
      "attestationKey": "04…", "attestation": { … } }
```

The buyer checks that the certificate recovers to `worker`, that `pool` is the
seller it is paying, and that it has not expired. When an attestation is
present it must verify (see [Hardened Macs](#hardened-macs)) or the buyer
refuses the worker; a buyer configured with `requireAttestedWorkers` also
refuses workers that are not attested hardened Macs. It keeps the assignment per
(seller, service) until it expires or the pool answers `421` with
`{"error":{"code":"worker_unavailable"}}`, then reassigns and retries once.
Paths under `/_antseed/provider/` are free control routes: the seller hands
them to the provider serving the body's `model` (`Provider.handleControlRequest`)
without payment or metering, rate limited per buyer. A pool refuses plaintext
buyer requests with `428` `{"error":{"code":"e2e_required"}}`; it seals the
seller's own health probes to a worker itself.

## Request envelope

The buyer replaces the request body with:

```json
{
  "model": "<service>",
  "stream": true,
  "max_tokens": 1024,
  "antseed_e2e": {
    "v": 2,
    "worker": "0x…",
    "epk": "<base64 uncompressed P-256 ephemeral public key>",
    "ct": "<base64 ChaCha20-Poly1305 ciphertext of the original JSON body>",
    "buyer": "0x…",
    "channel": "0x…",
    "sig": "0x…"
  }
}
```

`model`, `stream` and `max_tokens` stay in the clear for routing, streaming
and budget checks. Everything else is in `ct`.

Key schedule, per request (a fresh ephemeral key every time):

```
shared   = ECDH-P256(ephemeralPrivate, workerKey)   (the x-coordinate, 32 bytes)
okm      = HKDF-SHA256(ikm = shared, salt = epk ‖ workerKey, info = "antseed-worker-e2e/v2", length = 64)
reqKey   = okm[0:32]
respKey  = okm[32:64]
ct       = ChaCha20-Poly1305(reqKey, nonce = 12 zero bytes, aad = "antseed-worker-e2e/v2|req|" ‖ worker ‖ "|" ‖ model)
```

The worker rejects the request unless the inner body's `model` equals the
outer `model` (the AAD already binds it).

`sig` is the buyer's EIP-191 signature over
`keccak256("antseed-worker-e2e/v2" ‖ worker ‖ channel ‖ keccak256(ct))`
(addresses as 20 bytes, `channel` as 32 bytes). It proves the request came from
a buyer of this pool, so an operator cannot feed a worker requests of its own
and relay the results to a buyer under a different key. A worker that checks
the chain verifies that `channel` belongs to `buyer` and to the pool seller.

## Response envelope

Non-streaming: the worker answers

```json
{ "antseed_e2e": { "v": 2, "ct": "<base64>" }, "usage": { … } }
```

where `ct` is the upstream body sealed with `respKey`, nonce 0, AAD
`"antseed-worker-e2e/v2|resp|0|end"`.

Streaming: each upstream SSE event `data: X` becomes

```
data: {"antseed_e2e":{"seq":n,"ct":"<base64>"}}
```

sealed with `respKey`, nonce = `seq` as a 96-bit big-endian counter starting
at 0, AAD `"antseed-worker-e2e/v2|resp|<seq>"`. The last event sets
`"end":true` and uses AAD `"antseed-worker-e2e/v2|resp|<seq>|end"`, so a
truncated stream fails to verify.

In both cases the worker also emits the upstream `usage` in the clear (as the
`usage` field, or as one plain `data: {"choices":[],"usage":{…}}` event before
the final encrypted event) so the seller can meter. The buyer fails a
non-streamed response whose clear usage differs from the usage inside the
ciphertext, or that does not verify; a streamed one has already reached the
client, so a mismatch is logged against the seller.

The buyer attributes a request to the worker it encrypted the request for:
only that worker's key can decrypt it, so only that worker can answer it.

## Workers

- A worker serves only sealed requests addressed to it.
- A request without a valid buyer binding (or bound to the zero channel) is
  treated as the pool's own check: `max_tokens` is capped at 16 and checks are
  rate limited per hour, so a pool cannot buy real work with them.
- With an RPC endpoint, the worker checks in the background that each bound
  channel belongs to that buyer and to the pool seller (reads can lag a fresh
  reserve, so the first request is served while the check runs), and refuses a
  channel once the chain shows it belongs to someone else.

## Hardened Macs

On a Mac the decrypted prompt exists in the worker app's memory. The Antseed
Mac app keeps the Mac's owner out of it with the protections macOS gives a
signed app, and reports them in an attestation:

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
nonce the pool chose.

1. The worker's signed attestation names its Mac (`serial`, `udid`).
2. The pool asks its MDM to send that Mac a `DeviceInformation` command
   querying `DevicePropertiesAttestation`, with
   `DeviceAttestationNonce = sha256("antseed-device-attestation/v1\n" ‖ worker ‖ "\n" ‖ attestationKey ‖ "\n" ‖ challenge)`
   for a fresh random `challenge`.
3. It verifies that the chain leads to Apple's root, that the freshness code
   (OID 1.2.840.113635.100.8.11.1) equals that nonce, that the serial number
   (…8.9.1) is the one the worker attested, and that SIP (…8.13.1) is on. The
   pool repeats this daily.
4. Assignments carry `deviceAttestation: { chain, challenge }`. Buyers
   recompute the nonce from the worker, its certified attestation key and the
   challenge, and verify the chain themselves (accepting one up to 26 hours
   old). A buyer with `requireAppleVerifiedWorkers` refuses workers without
   it.

Because the nonce names the worker and its attestation key, the pool can't
reuse one Mac's attestation for another worker.

Pool settings: `COLONY_POOL_MDM_URL`, `COLONY_POOL_MDM_API_KEY`,
`COLONY_POOL_MDM_WEBHOOK_PORT` and `COLONY_POOL_MDM_WEBHOOK_PATH` connect a
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

The buyer appends a worker block after the ABI-encoded metadata (v4). ABI
decoders read the head by offset and ignore trailing bytes, so existing
indexers are unaffected.

```
metadata = abi.encode(v4 fields…) ‖ entries ‖ uint8 count ‖ bytes32 WORKER_TAIL_MAGIC
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

The pool is staked like any seller façade (`staking.stakeFor(pool, agentId,
amount)` once it owns its ERC-8004 agent), and must own that agent to receive
emissions. The buyer decides the split it signs; the contract enforces only
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
button. The seller dashboard shows the pool operator each worker's status,
speed, requests and earnings from the pool's ledger.
