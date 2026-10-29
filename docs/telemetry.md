# AntSeed Telemetry

AntSeed collects privacy-conscious product telemetry from three places, all
sent to one PostHog project:

| `product` | What it is | Default |
| --- | --- | --- |
| `desktop` | The AI VPN desktop app: its own screens and funnel | On, opt-out in Preferences → Privacy |
| `gateway` | The API-key gateway: only its setup funnel (`gateway_step`) | On, opt-out in the console's Settings → Privacy; a one-time notice in the server log |
| `buyer` | The buyer proxy, whoever runs it: the desktop, the gateway, or `antseed buyer start` on its own | On, opt-out |

The split is simple: a host reports only its own UI (the desktop's screens,
the gateway's setup steps), and all usage and reliability data comes from the
buyer, the same way for every host. Other CLI commands send nothing. A
gateway's requests are reported by the buyer it runs, tagged
`buyer_host: gateway`.

It tells us how people get started (first open → setup → deposit → first
chat) and whether the network serves requests reliably. Events are associated with the buyer's public on-chain
address. This document lists every event and property, what is never
collected, and how to turn telemetry off.

Implementation:
- Shared rules (buckets, failure taxonomy, the allowlist sanitizer, consent,
  the PostHog transport): `packages/telemetry`.
- Desktop: `apps/desktop/src/main/telemetry/`.
- Buyer and gateway: `apps/cli/src/telemetry/` (`catalog.ts` lists every
  event and allowed value).

## Desktop: what we collect

Every event, from every product, includes this envelope:

| Property | Description |
| --- | --- |
| `schema_version` | Event schema version (currently `2`, which added `product`). |
| `product` | `desktop`, `gateway` or `buyer`: the process that sent the event. |
| `event_ts_ms` | Event timestamp in milliseconds. |
| `session_id` | Random UUIDv7 regenerated on every launch. |
| `$session_id` | The same launch id under PostHog's reserved name, so each launch appears in PostHog's Sessions explorer. |
| `app_version` | Desktop app version (e.g. `0.2.31`). |
| `platform` | Operating system (`darwin`, `win32`, `linux`). |
| `arch` | CPU architecture (`x64`, `arm64`). |
| `install_source` | Distribution channel. Desktop: `dmg`, `nsis`, `appimage`, `deb`, `unknown`. Buyer and gateway: how the CLI was installed (`npm`, `pnpm`, `yarn`, `bun`, `volta`, `npx`, `nix`, `installer`, `desktop`, `local`, `source`). |
| `buyer_host` | Buyer events only: who started this buyer (`desktop`, `gateway`, `standalone`). |
| `host_session_id` | Buyer events only, when a host started it: the host's `session_id`, so buyer events join the desktop session. |

### Events

- `app_first_opened` — once per installation. Properties: `first_open_date`
  (YYYY-MM-DD).
- `app_started` — once per launch. Properties: `is_first_launch`.
- `network_runtime_started` — once per launch when the buyer runtime's
  structured status endpoint first responds. Properties: duration bucket from
  app launch.
- `dht_started` — once per launch when structured buyer status reports at
  least one DHT routing node. Properties: duration bucket from app launch and
  a coarse routing-node-count bucket.
- `peers_discovered` — once per launch when structured buyer status first
  reports peers. Properties: duration bucket from app launch and coarse peer
  and advertised-service count buckets. Cached peer state is used only as a
  compatibility fallback for older runtimes without a structured peer count.
- `first_model_shown` — once per launch when the first selected model is
  actually rendered on the Home screen. Properties: duration from app start,
  public model ID, service category, route mode, buyer-eligible free/paid
  pricing classification, and a coarse eligible-offer-count bucket.
- `user_action` — for every allowlisted meaningful product action. Properties:
  fixed `action` and `surface` enums, duration from app start, and
  `is_first_action`. This covers navigation; runtime start/stop and discovery
  refresh; chat creation/open/send/stop/retry, attachments, and image
  generation; routing choices; connected-app connect/disconnect and
  configuration copy; deposit/withdraw starts; workspace changes; and plugin
  installation.
- `setup_completed` — when first-run setup completes. Properties:
  `duration_bucket` (`under_30s`, `30s_2m`, `2m_5m`, `over_5m`).
- `deposit_completed` — when a deposit is observed credited. Properties:
  `method_category` (always `usdc`, kept for existing queries), `method` (the
  funding method last chosen in this launch: `card`, `crypto_wallet`,
  `payment_app`, `exchange` or `unknown`), `amount_bucket` (`under_5`,
  `5_25`, `25_100`, `100_plus`), `is_first_deposit`, `days_since_first_open`
  (`0`, `1_7`, `8_30`, `31_plus`).
- `deposit_step` — one step of the Add credits funnel. Properties: `step`
  (`method_shown`, `method_chosen`, `checkout_opened`, `checkout_reopened`,
  `checkout_abandoned`, `credited`; `card_declined` and `payment_submitted`
  are reserved but not emitted, because the hosted
  checkout pages report no such signal to the app), `method` (as above;
  `payment_app` is Peer Pay, and Meridian counts as `crypto_wallet`), an
  optional `amount_bucket` of the entered amount (`le_5`, `5_10`, `10_50`,
  `over_50`), and `secs_since_prev_step` (`first`, `under_10s`, `10s_1m`,
  `1m_5m`, `over_5m`). A second `checkout_opened` in a launch is sent as
  `checkout_reopened`. `checkout_abandoned` is sent when the Add credits view
  closes after a checkout opened and before a credit.
- `deposit_failed` — when automatic deposit setup or a sweep attempt fails.
  Properties: `method_category`, fixed `failure_code`, fixed `failure_stage`,
  and `retryable`. Raw provider, RPC, wallet, and relayer errors are never sent.
- `first_chat_started` — once per installation, on the first valid chat
  request. Properties: `had_deposit`, `deposit_bucket`,
  `days_since_first_open`, `service_category` (`chat`, `image`, `other`),
  `has_attachments`.
- `model_selected` — once when the effective model or seller route changes,
  even when that selection is persisted through both default-route and active-
  conversation paths.
  Properties: public advertised `public_model_id` (or `custom_or_unknown`),
  `service_category`, auto/pinned route mode, whether any buyer-policy-eligible
  offer is free, a `free`, `paid`, `mixed`, or `unknown` pricing tier, and a
  coarse eligible-offer-count bucket. Model and seller selections are not also
  emitted as generic `user_action` events.
- `chat_request_started` — immediately before each valid remote chat attempt,
  after local preflight and session construction succeed. Properties: a random
  per-request `request_id`, public model ID, service category, route mode,
  privacy-safe eligible-offer pricing context, a coarse offer-count bucket,
  and `has_attachments`.
- `chat_request_finished` — once for every valid remote chat attempt, including
  success, failure, and cancellation. It carries the same random `request_id`
  as `chat_request_started`, plus `outcome`, fixed `failure_code` and
  `failure_stage`, public advertised `public_model_id` (or
  `custom_or_unknown`), `service_category`, `route_mode`, coarse offer-count,
  HTTP-status and duration buckets, retry flags, `had_partial_output`, and
  `has_attachments`. Peer IDs and raw stream errors are never sent.
  Reliability fields, all classified on device:
  - `failure_reason`: `none`, `out_of_credits`, `model_needs_paid` (balance
    is zero and no free seller serves the model), `seller_dropped_before_output`,
    `seller_dropped_mid_answer`, `seller_5xx`, `request_rejected` (other 4xx),
    `rate_limited`, `no_seller_available`, `no_seller_yet` (no peers were
    discovered yet), `seller_unreachable`, `timeout`, `local_error` (a buyer-side
    fault such as inactive payments) or `unknown`.
  - `http_status`: the exact status code of the last failure (100–599), when
    known. Omitted otherwise.
  - `attempt_count` (`1`, `2`, `3_plus`): 1 plus automatic retries.
  - `answered_by_different_seller`: a retry succeeded on a seller other than
    the one preferred at send.
  - `secs_since_app_start` (`under_30s`, `30s_2m`, `2_10m`, `over_10m`) and
    `peers_discovered_at_send`.
  - `sellers_known_bucket` and `free_sellers_known_bucket` (`0`, `1`, `2_3`,
    `4_plus`): distinct sellers, and free sellers, for the model at send.
  - `buyer_balance_zero`: from the cached balance only; omitted when the
    balance has not been read yet.
  - Which sellers were tried, whether the request fell back and the seller's
    tier are not sent here. The buyer the desktop runs reports them exactly
    on `buyer_request_finished` (same wallet and `host_session_id`), because
    only the proxy sees every attempt.
  - `ttft_bucket` (`none`, `under_1s`, `1_3s`, `3_10s`, `over_10s`): time to the
    first streamed token of the final attempt.
  - The desktop sends no seller identifier. The seller that handled a request
    is `seller_id` on the buyer's `buyer_request_finished`.
- `startup_finished` — once per launch. `outcome` is `success` when the first
  model is shown, or `failed` when no model is shown within 3 minutes.
  `failure_stage` (`none`, `runtime`, `dht`, `peer_search`, `models`) is the
  first stage not reached. Also carries a `duration_bucket` from app start.
- `connected_app_first_request` — once per connect. Properties: `app` (the
  same fixed app enum as `user_action`), `outcome` (`request_seen` or
  `no_request`), and `secs_since_connect` (`under_1m`, `1_5m`, `5_30m`, or
  `none` without a request). A request is detected by polling the local buyer
  proxy's conversation list for the app's client slugs, or a variant of one
  (Codex's requests say `codex-exec` or `codex-desktop`). Only the app enum
  leaves the device. Apps without packaged client slugs (Telegram, custom apps)
  report `no_request`. The window is 30 minutes or the end of the launch.
- `premium_blocked` — when a request fails because the model needs a paid
  seller and the buyer's balance is zero. Properties: `public_model_id`,
  `service_category`.
- `premium_blocked_followup` — at most once after `premium_blocked`, in the
  same launch. `next_action` is `deposited`, `switched_free_model` or `left`
  (the app closed first).
- `withdraw_started` and `withdraw_completed` — the withdraw page was opened,
  and the payments portal reported a completed payment after that, with no
  other pay page (deposit, channel close) opened in between. No properties.
- `runtime_stopped_on_window_close` — Windows and Linux only: closing the last
  window quits the app and stops the buyer runtime. Properties:
  `runtime_was_running`.
- `discovery_failed` — only when a model discovery request fails. Properties:
  duration bucket and a fixed `failure_code` (`timeout`, `invalid_data`,
  `io_error`, or `unknown`). Successful periodic discovery requests do not
  emit telemetry.
- `app_closed` — on clean shutdown (`was_crash: false`), or recovered on the
  next launch after an unclean shutdown (`was_crash: true`). Properties:
  `was_crash`, `session_duration_bucket`.

## Buyer: what we collect

- `buyer_started` — when a buyer starts. Properties: `payments_enabled`,
  `verifier_enabled`, `owns_proxy_port`.
- `buyer_deposit_credited` — when a deposit is credited to any of the
  buyer's wallets (a gateway's workspace wallets included). Properties:
  `amount_bucket` (`zero`, `under_0_01`, `0_01_0_1`, `0_1_1`, `1_10`,
  `over_10`, in USDC). For a gateway this is its "money added" step.
- `buyer_request_finished` — one per model request the proxy handles, from
  every buyer (desktop, gateway or standalone): chats, image generation and
  edits, decision models (SystemOne) and video. Properties:
  - `protocol`: the API the client spoke (`anthropic-messages`,
    `openai-chat-completions`, `openai-completions`, `openai-responses`,
    `openai-images`, `typesafe-systemone`, `video`, `unknown`).
  - `video_action`, on video requests only: `create` (starting a job) or
    `retrieve` (a status poll or the download). A job is one `create` and
    then `retrieve` calls until it is done, so count jobs by `create`.
  - `public_model_id`: as on the desktop, a reviewed public model id or
    `custom_or_unknown`.
  - `route_mode`: `auto`, `pinned` (a seller was named) or `router` (a
    routing service chose).
  - `client_tool`: the coding tool, from its own session headers or user
    agent. A connected app is reported under its name in the shared
    connected-apps list (`@antseed/connected-apps`, the same names as the
    desktop's `app_connect`): `claude-code`, `claude-desktop`, `codex`,
    `opencode`, `hermes`, `gooeypi` and the rest. A tool slug counts for an
    app when it is one of the app's slugs or a variant of one (`codex-exec`,
    `codex_exec`, `Codex Desktop` → `codex`; `hermes-agent` → `hermes`;
    `claude-cli` → `claude-code`), the same rule the desktop uses to group
    chats by app. A new app added to that list is reported under its own name
    with no telemetry change. Other recognized tools (`cursor`, `cline`,
    `aider`, `continue`, `openclaw`) keep their name, any other client is
    `custom`, and `none` when the request names no tool.
  - `outcome`: `success` (the whole answer arrived), `failed`, or
    `cancelled` (the client hung up before the answer finished, for example
    the user pressed stop, whether or not part of it had arrived).
    `cancelled` is not a failure: count success rate as success ÷ (success +
    failed). A cancelled request sends no token counts, output speed or cost.
  - `failure_reason`: the same fixed taxonomy as the desktop's
    `chat_request_finished`, classified from what the network did.
  - `http_status`: the failed request's status, an integer in 100–599.
  - `attempt_count` (`1`, `2`, `3_plus`), `sellers_tried` (`0`, `1`, `2`,
    `3_plus`), `fell_back` (more than one seller was tried).
  - `seller_tier`: `free`, `paid` or `unknown`, from the seller's advertised price.
  - `streamed`: the answer was streamed to the client.
  - `ttft_ms`: exact milliseconds from the request to the first byte of the
    answer that was used: what the caller waited (omitted when no answer
    arrived; an error reply is not output). After a fallback this is the
    answering seller's first byte, not an earlier seller's error reply, and
    the time spent on the failed sellers is included.
  - `seller_ttft_ms`: the answering seller's own time to first byte, from
    the moment its attempt was sent. Equal to `ttft_ms` when the first
    attempt answered.
  - `failed_attempts_ms`: milliseconds lost to failed attempts: sellers that
    failed, rate-limit retries and their waits. 0 when the first attempt
    answered; for a request that failed on every seller, all of its time.
  - `rate_limited`: a seller answered 429 (busy) on some attempt of this
    request. A used-up free allowance is also a 429 but is not counted here.
  - `routing_version`: which seller-selection algorithm routed the request
    (`v1` today), so a new algorithm can be compared with the current one.
  - `duration_ms`: exact milliseconds until the request finished (time to the
    last token for a streamed answer).
  - `client_retry`: the client sent this same request again within two
    minutes of a copy that did not succeed. Coding tools retry a failed turn
    on their own (Codex up to five times, shown as "Reconnecting"), so one
    failure would otherwise look like several. A retry keeps its turn number.
    The match uses a hash of the request's content (JSON keys sorted, since
    Codex reorders them between retries), held in memory only and never sent.
  - `seller_id`: the public peer id (the seller's on-chain address, 40 hex
    characters) of the seller that answered, or of the last seller tried
    when none did. Sellers are public on the network, and paid buyer–seller
    pairs are public on-chain; it is sent so cache and failure rates can be
    compared per seller. Only this one seller is sent, never the others tried.
  - `conversation_key_source`: how the proxy grouped the request into a
    conversation. `tool_session` (the tool's own session id), `prompt_cache_key`
    (the client's prompt cache key alone), `prompt_prefix` (a hash of the
    conversation's opening, for a known client that sends neither) or `none`.
    The key itself never leaves the process.
  - `turn_bucket` (`1`, `2_5`, `6_20`, `21_plus`, or `unknown` for a
    conversation that began before the buyer started): which turn of its
    conversation this is. Omitted without a conversation.
  - `seller_choice`: `first_turn`, `kept_previous` (the seller that answered the
    conversation's last turn answered this one), `switched`, `no_conversation`
    or `no_answer` (the request did not succeed).
  - `switch_reason`, only when `switched`: `previous_failed` (it was tried and
    failed), `previous_cooling_down`, `previous_unhealthy` (failing lately),
    `previous_unavailable` (no longer offering the model), `previous_excluded`
    (outside the buyer's policy), `needs_funds` (no deposit for a paid seller),
    `policy_route` (a route chain put another seller first), `pinned_elsewhere`,
    `router_choice` or `other`.
  - `candidates_bucket` (`0`, `1`, `2_3`, `4_plus`): sellers eligible for the
    request. `chosen_rank` (`1`, `2`, `3_plus`): the rank of the last seller
    tried.
  - `usage_reported`: whether the seller reported token usage for a
    successful answer (otherwise the proxy only estimates it from body sizes).
  - `input_tokens` and `cached_input_tokens`: the exact input token count of a
    successful answer (cache hits included) and how many of those the seller
    served from its prompt cache, as the seller reported them. Sent only when
    `usage_reported` is true; an estimate cannot see the cache, so it is never
    sent as a count. The cache rate is `sum(cached_input_tokens) /
    sum(input_tokens)`. With `seller_id`, `public_model_id` and the seller's
    public price, these allow an estimate of a request's cost.
  - `output_tokens`: the exact output token count of the same answer, sent
    under the same rule. Speed (tokens per second) is
    `output_tokens / (duration_ms - ttft_ms) * 1000` for a streamed answer.
  - `estimated_cost_micro_usd`: what the answer costs at the seller's listed
    prices for the reported token counts (cache hits at the cached rate), in
    millionths of a USD. Zero when the seller's free allowance covered it;
    omitted when the seller lists no price. An estimate, not the amount
    settled on-chain.
  - `finish_reason`, for a successful answer: why it ended, read from the
    response (`stop`, `length` for the output cap, `tool_call`,
    `content_filter`, `refusal`, `other`, or `unknown` when the response does
    not say).

The buyer remembers each conversation's turn count and last seller in memory
only (at most 5,000 conversations, the least recent dropped first), so the
counts start over when the buyer restarts.

A gateway's buyer sends the same events, never with a key, member, workspace
or end-user id, name or label.

### Routing scorecard

How the routing comparison (current vs. a new algorithm) is built from
`buyer_request_finished`, split by `routing_version` and limited to
`outcome = success` unless noted:

| Measure | From |
|---|---|
| TTFT p50 / p95 (seller) | `seller_ttft_ms` |
| Caller TTFT p50 / p95 | `ttft_ms` |
| Throughput p50 (tokens/s) | `output_tokens / (duration_ms - ttft_ms) * 1000`, streamed answers |
| Cost per 1,000 requests | `sum(estimated_cost_micro_usd) / count / 1e6 * 1000` |
| Cost per 1M tokens | `sum(estimated_cost_micro_usd) / sum(input_tokens + output_tokens)` |
| Whole request p50 / p95 (time to last token) | `duration_ms` |
| Hit at least one 429 | share of requests (any outcome) with `rate_limited` |
| Needed a retry | share of requests (any outcome) with `attempt_count` other than `1` |
| Time spent in failed attempts, per request | mean of `failed_attempts_ms` (any outcome) |

The cost measures need `usage_reported` and a listed price; requests without
them are left out of both the sum and the count.

## Gateway setup funnel

The gateway sends one event, `gateway_step`, with one property, `step`, so we
can see how far a team gets in setting a gateway up, where teams drop off,
and whether they come back:

| `step` | When |
| --- | --- |
| `gateway_started` | The gateway starts (each start). |
| `console_claimed` | The owner claims the console with the setup link. |
| `workspace_created` | A workspace is created. |
| `key_created` | An API key is created. |
| `member_invited` | A member is invited. |
| `invite_accepted` | An invited member accepts. |
| `signed_in` | Someone signs in to the console (the return signal for retention). |

Every occurrence is sent; a PostHog funnel uses the first. Money added is the
buyer's `buyer_deposit_credited`, and the first request is the buyer's first
`buyer_request_finished`, both under the same wallet.

Steps come from the gateway's audit log, which every console and CLI action
already writes, so no request handler calls telemetry. Only the step name is
sent: never the audit entry's actor, target, details or IP, so no key,
member, workspace, email, name or label. Events use the gateway's default
wallet as `distinct_id` (the same one its buyer runs with).

## What we never collect

- Prompts, chat messages, or assistant responses
- Transaction hashes
- Exact balances, deposits, or spending (only coarse buckets; the buyer's
  exact token counts, timings and estimated cost per request are sent, see
  `buyer_request_finished`)
- Files, attachment contents, file names, or paths
- Environment variables, command lines, logs, or stack traces
- Peer IDs, except `seller_id` on `buyer_request_finished`: the one seller
  that handled the request
- Raw provider, model, relayer, RPC, or discovery errors
- Location, IP-derived fields, session recordings, screenshots, or frontend
  autocapture
- CLI arguments, flags, file paths, config values or command output
- API keys, gateway members, workspaces, end users, or their names or labels

All event properties pass through a strict allowlist: unknown properties are
dropped, strings are truncated to 64 characters, numbers are bounded, and
bucket values are validated.

Failure events use fixed local taxonomies. Error messages are classified on
device and discarded before the telemetry service is called. Exact model IDs
are included only when the selected service is currently advertised, exists in
the release-owned reviewed model registry, and matches a conservative slug
format; other values become `custom_or_unknown`.

Network lifecycle events reuse the buyer runtime's structured status signals.
The desktop does not upload, parse, or derive telemetry properties from its
human-readable logs. Model pricing is classified locally from offers that pass
the buyer's routing price policy; exact prices never enter telemetry.

User actions are explicit semantic signals from maintained controller paths.
The app does not enable PostHog autocapture and does not record arbitrary clicks,
button labels, typed values, scrolls, hovers, URLs, clipboard contents, or view
names outside the fixed documented surface enum. The main process validates
the action and surface, calculates elapsed time, and marks only the first valid
action in each launch with `is_first_action: true`.

The setup event is emitted only after an actual first-run plugin installation
starts. Routine refreshes of an already-installed plugin do not begin a setup
measurement; a repair may only finish a first-run measurement that was already
started before an interrupted install.
Immediately before the first valid chat is submitted, the app reads the current
on-chain deposit balance locally and converts it to `had_deposit` and a coarse
bucket. The exact balance never enters the telemetry service.

## On-chain identifier

The buyer's normalized lowercase EVM address is sent as PostHog's required
`distinct_id`. It is read from the same encrypted signing identity used by the
desktop app and is not duplicated as an event property or stored in telemetry
state. The buyer uses the wallet it runs with. If no valid identity is available, telemetry events are not sent. A
fresh random `session_id` (a UUIDv7, also sent as `$session_id`) is generated
on every launch.
Each valid remote chat attempt also receives a random `request_id` used only to
correlate its start and finish events. It is not derived from chat contents,
the on-chain identifier, a peer, or a wallet.

When telemetry is introduced to an existing installation, the pre-existing
encrypted or legacy signing identity suppresses `app_first_opened` if no valid
telemetry state exists yet. This prevents an upgrade from being counted as a
new installation. A genuinely fresh install, where the app creates both the
identity and telemetry state for the first time, still emits the event.

## How to disable telemetry

- Desktop: **Preferences → Privacy → Product telemetry**. This also turns off
  the buyer the desktop runs, within a second, and any buyer it starts later.
  If the buyer's config file cannot be written, the switch flips back and
  the setting stays as it was.
- Desktop environment kill switch: set `TELEMETRY_ENABLED=false` (or `0` / `no`).
- Buyer (standalone or a gateway's) and gateway: `antseed telemetry disable` (`antseed
  telemetry status` shows the current state and why). It sets
  `telemetry.enabled: false` in the config file; a running buyer and gateway pick
  it up without a restart.
- Gateway console: **Settings → Privacy → Product telemetry** (org admins),
  like the desktop's toggle. It flips the same config setting for the
  gateway and the buyer it runs, and is recorded in the audit log as
  `settings.telemetry.update`.
- Any product: `DO_NOT_TRACK=1` or `ANTSEED_TELEMETRY=0` in the environment.
- Telemetry is always off in development builds, in CI (`CI` set) and when no
  PostHog project is configured.

Release builds of the desktop app and of the npm CLI bake the public PostHog
ingestion host and project token from CI configuration
(`scripts/bake-desktop-telemetry-config.mjs`), because GUI-launched apps and
npm installs do not inherit build-shell environment variables. A release fails
if either value is missing. Source builds, including `nix build`, contain no
default and therefore send nothing unless `POSTHOG_HOST` and
`POSTHOG_PROJECT_API_KEY` are set.

## Data handling

- Events are sent to PostHog over HTTPS with a short timeout. Routine captures
  are fire-and-forget; clean shutdown uses a bounded final flush.
- Telemetry failures never affect startup, chat, or payments, and cannot delay
  shutdown beyond the short flush timeout.
- Every capture sets `$geoip_disable: true`, so PostHog does not enrich events
  with location derived from the request IP.
- Every capture sets `$process_person_profile: false`; captures do not create
  PostHog person profiles.
- Clean shutdown waits briefly for the final `app_closed` capture while also
  clearing the local crash marker. Delivery remains bounded by a short flush
  timeout.
- While the app runs, a local-only heartbeat updates the crash marker once per
  minute. Crash recovery uses the last heartbeat, so time spent offline before
  the next launch is not counted as session duration.
- Contact: hello@antseed.com

The PostHog hosting region and retention period are deployment policy, not
application defaults. They must be approved and documented here before the
release variables are enabled for production.
