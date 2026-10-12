# AI VPN Desktop Telemetry

The Antseed AI VPN desktop app collects privacy-conscious product telemetry to
understand the activation funnel (first open → setup → deposit → first chat),
network readiness, model selection, and app reliability. Events are associated
with the buyer's public on-chain address. This document lists every event and
property, what is never collected, and how to disable telemetry.

Implementation: `apps/desktop/src/main/telemetry/`
(`telemetry.ts`, `events.ts`, `sanitize.ts`, `posthog.ts`, `state.ts`).

## What we collect

Every event includes this envelope:

| Property | Description |
| --- | --- |
| `schema_version` | Event schema version (currently `1`). |
| `event_ts_ms` | Event timestamp in milliseconds. |
| `session_id` | Random UUIDv7 regenerated on every launch. |
| `$session_id` | The same launch id under PostHog's reserved name, so each launch appears in PostHog's Sessions explorer. |
| `app_version` | Desktop app version (e.g. `0.2.31`). |
| `platform` | Operating system (`darwin`, `win32`, `linux`). |
| `arch` | CPU architecture (`x64`, `arm64`). |
| `install_source` | Distribution channel (`dmg`, `nsis`, `appimage`, `deb`, `unknown`). |

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
  `method_category`, `amount_bucket` (`under_5`, `5_25`, `25_100`,
  `100_plus`), `is_first_deposit`, `days_since_first_open` (`0`, `1_7`,
  `8_30`, `31_plus`).
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
- `discovery_failed` — only when a model discovery request fails. Properties:
  duration bucket and a fixed `failure_code` (`timeout`, `invalid_data`,
  `io_error`, or `unknown`). Successful periodic discovery requests do not
  emit telemetry.
- `app_closed` — on clean shutdown (`was_crash: false`), or recovered on the
  next launch after an unclean shutdown (`was_crash: true`). Properties:
  `was_crash`, `session_duration_bucket`.

## What we never collect

- Prompts, chat messages, or assistant responses
- Transaction hashes
- Exact balances, deposits, or spending (only coarse buckets)
- Files, attachment contents, file names, or paths
- Environment variables, command lines, logs, or stack traces
- Peer IDs
- Raw provider, model, relayer, RPC, or discovery errors
- Location, IP-derived fields, session recordings, screenshots, or frontend
  autocapture

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
state. If no valid identity is available, telemetry events are not sent. A
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

- In the app: **Preferences → Privacy → Product telemetry** toggle.
- Environment kill switch: set `TELEMETRY_ENABLED=false` (or `0` / `no`).
- Telemetry is always disabled in development builds and when no PostHog
  project is configured.

Release builds bake the public PostHog ingestion host and project token from
CI configuration because GUI-launched desktop apps do not inherit build-shell
environment variables. A release fails if either value is missing. Source
builds contain no default and therefore send nothing unless configured locally.

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
