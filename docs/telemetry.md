# AntSeed Telemetry

AntSeed collects privacy-conscious product telemetry from four places, all sent
to one PostHog project:

| `product` | What it is | Default |
| --- | --- | --- |
| `desktop` | The AI VPN desktop app | On, opt-out in Preferences → Privacy |
| `cli` | The `antseed` command | On, opt-out; a one-time notice on first run |
| `buyer` | The buyer proxy (`antseed buyer start`), run alone, by the desktop or by the gateway | Follows the CLI's choice, or its host's |
| `gateway` | The API-key gateway (`antseed gateway start`, `antseed tunnel start`) | On, opt-out in the console's Settings → Privacy; a one-time notice in the server log |

It tells us how people get started (first open → setup → deposit → first
chat), whether the network serves requests reliably, and which products and
commands are used. Events are associated with the buyer's public on-chain
address. This document lists every event and property, what is never
collected, and how to turn telemetry off.

Implementation:
- Shared rules (buckets, failure taxonomy, the allowlist sanitizer, consent,
  the PostHog transport): `packages/telemetry`.
- Desktop: `apps/desktop/src/main/telemetry/`.
- CLI, buyer and gateway: `apps/cli/src/telemetry/` (`catalog.ts` lists every
  event and allowed value).

## Desktop: what we collect

Every event, from every product, includes this envelope:

| Property | Description |
| --- | --- |
| `schema_version` | Event schema version (currently `2`, which added `product`). |
| `product` | `desktop`, `cli`, `buyer` or `gateway`: the process that sent the event. |
| `event_ts_ms` | Event timestamp in milliseconds. |
| `session_id` | Random UUIDv7 regenerated on every launch. |
| `$session_id` | The same launch id under PostHog's reserved name, so each launch appears in PostHog's Sessions explorer. |
| `app_version` | Desktop app version (e.g. `0.2.31`). |
| `platform` | Operating system (`darwin`, `win32`, `linux`). |
| `arch` | CPU architecture (`x64`, `arm64`). |
| `install_source` | Distribution channel. Desktop: `dmg`, `nsis`, `appimage`, `deb`, `unknown`. CLI, buyer, gateway: how the CLI was installed (`npm`, `pnpm`, `yarn`, `bun`, `volta`, `npx`, `nix`, `installer`, `desktop`, `local`, `source`). |
| `buyer_host` | Buyer events only: who started this buyer (`desktop`, `gateway`, `standalone`). |
| `host_session_id` | Buyer events only, when a host started it: the host's `session_id`, so buyer events join the desktop or gateway session. |

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
  `checkout_abandoned`, `credited`; `region_unsupported`, `card_declined` and
  `payment_submitted` are reserved but not emitted, because the hosted
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
  - `seller_hash`: **pending privacy sign-off, default OFF.** A salted one-way
    seller identifier, behind `TELEMETRY_SELLER_HASH_ENABLED` in
    `events.ts`. While the flag is off, the app does not send it and the
    sanitizer drops it. Peer IDs are not sent.
- `startup_finished` — once per launch. `outcome` is `success` when the first
  model is shown, or `failed` when no model is shown within 3 minutes.
  `failure_stage` (`none`, `runtime`, `dht`, `peer_search`, `models`) is the
  first stage not reached. Also carries a `duration_bucket` from app start.
- `connected_app_first_request` — once per connect. Properties: `app` (the
  same fixed app enum as `user_action`), `outcome` (`request_seen` or
  `no_request`), and `secs_since_connect` (`under_1m`, `1_5m`, `5_30m`, or
  `none` without a request). A request is detected by polling the local buyer
  proxy's conversation list for the app's client slugs. Only the app enum
  leaves the device. Apps without packaged client slugs (Telegram, custom apps)
  report `no_request`. The window is 30 minutes or the end of the launch.
- `premium_blocked` — when a request fails because the model needs a paid
  seller and the buyer's balance is zero. Properties: `public_model_id`,
  `service_category`.
- `premium_blocked_followup` — at most once after `premium_blocked`, in the
  same launch. `next_action` is `deposited`, `switched_free_model` or `left`
  (the app closed first).
- `withdraw_started` and `withdraw_completed` — the withdraw page was opened,
  and the payments portal reported a completed payment after that. No
  properties.
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

## CLI, buyer and gateway: what we collect

### CLI

- `cli_command_run` — once per command that returns. Properties: `command`
  (the command's name from the command tree, such as `buyer deposit` or
  `gateway key create`; never its arguments, flags or values), `outcome`
  (`success`, `failed`), `duration_bucket`, `is_first_run`. Long-running
  servers (`buyer start`, `gateway start`, `tunnel start`) send their own
  start events instead. CLI processes the desktop or the gateway start send no
  command events.

### Buyer

- `buyer_started` — when a buyer starts. Properties: `payments_enabled`,
  `verifier_enabled`, `owns_proxy_port`.
- `buyer_request_finished` — one per model request the proxy handles.
  Desktop and standalone buyers send every request. A gateway's buyer carries
  many people's traffic, so it sends only the requests that change the
  journey (see `journey_moment`) and keeps routine successes local.
  Properties:
  - `protocol`: the API the client spoke (`anthropic-messages`,
    `openai-chat-completions`, `openai-completions`, `openai-responses`,
    `openai-images`, `typesafe-systemone`, `video`, `unknown`).
  - `public_model_id`: as on the desktop, a reviewed public model id or
    `custom_or_unknown`.
  - `route_mode`: `auto`, `pinned` (a seller was named) or `router` (a
    routing service chose).
  - `client_tool`: the coding tool, from its own session headers
    (`claude-code`, `codex`, `opencode`, `cursor` and others the proxy
    recognizes), `custom` for any other client, or `none`.
  - `outcome`: `success`, `failed`, `cancelled`.
  - `failure_reason`: the same fixed taxonomy as the desktop's
    `chat_request_finished`, classified from what the network did.
  - `http_status`: the failed request's status, an integer in 100–599.
  - `attempt_count` (`1`, `2`, `3_plus`), `sellers_tried` (`0`, `1`, `2`,
    `3_plus`), `fell_back` (more than one seller was tried).
  - `seller_tier`: `free`, `paid` or `unknown`, from the seller's advertised price.
  - `ttft_bucket`, `duration_bucket` (`under_1s`, `1_5s`, `5_30s`, `30s_2m`,
    `over_2m`), `streamed`.
  - `journey_moment`, set when the request is one of these moments:
    `first_success` (the buyer's first answer since it started), `failure`,
    `cancelled`, `fell_back` (answered after another seller was tried) or
    `recovered` (the first answer after a failure). A gateway's buyer sends
    only requests with a moment.

### Gateway

- `gateway_started` — when the gateway starts. Properties: `listen_exposure`
  (`loopback`, `private`, `public`, `any`, or `name` for a hostname),
  `console_enabled`, `x402_enabled`, and `workspace_count_bucket`,
  `key_count_bucket`, `member_count_bucket` (`0`, `1`, `2_5`, `6_20`,
  `21_plus`).
- `gateway_daily` — once a day while it runs. Properties: the same count
  buckets, and `uptime_days`.
- `gateway_topup` — an x402 top-up settled or was refused by the facilitator.
  Properties: `outcome` (`settled`, `rejected`), `amount_bucket` (`zero`,
  `under_0_01`, `0_01_0_1`, `0_1_1`, `1_10`, `over_10` USDC).

Gateway events never carry a key, member, workspace or end-user id, name or
label, and the gateway (and its buyer) send `$geoip_disable: true`: a
gateway's IP is where a team hosts it, not where its users are.

## What we never collect

- Prompts, chat messages, or assistant responses
- Transaction hashes
- Exact balances, deposits, or spending (only coarse buckets)
- Files, attachment contents, file names, or paths
- Environment variables, command lines, logs, or stack traces
- Peer IDs
- Raw provider, model, relayer, RPC, or discovery errors
- The request IP address, or any location field sent by the app. Location
  below country level is not used (see Data handling for PostHog GeoIP).
- Session recordings, screenshots, or frontend autocapture
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
state. The CLI and the gateway read the same public address from the
data directory's `identity.key` without decrypting it (an encrypted key file
stores its address in the clear); the buyer uses the wallet it runs with.
If no valid identity is available, telemetry events are not sent. A
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
  the buyer the desktop runs, within a second.
- Desktop environment kill switch: set `TELEMETRY_ENABLED=false` (or `0` / `no`).
- CLI, buyer and gateway: `antseed telemetry disable` (`antseed telemetry
  status` shows the current state and why). It sets `telemetry.enabled: false`
  in the config file; a running buyer and gateway pick it up without a restart.
- Gateway console: **Settings → Privacy → Product telemetry** (org admins). It
  flips the same config setting and is recorded in the audit log as
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
- For the desktop, the CLI and standalone buyers, PostHog derives an
  approximate location from the request IP at ingestion (GeoIP; captures do
  not send `$geoip_disable`). The gateway and its buyer turn GeoIP off. We use it at country level only,
  for regional analysis such as card-checkout availability. The IP itself is
  not stored: the project setting "discard client IP data" stays on. PostHog
  GeoIP also produces city and region fields. The team intends to drop
  everything below country with a PostHog transformation.
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
