/**
 * The gateway's setup funnel: one `gateway_step` event per step a team takes
 * (started, console claimed, first workspace, key, invite, accepted invite,
 * sign-in), so we can see where teams drop off and whether they come back.
 * Usage itself is reported by the buyer the gateway runs.
 *
 * Steps come from the audit log, which every console and CLI action already
 * writes, so no handler calls telemetry. Only the step name leaves the
 * process: never a key, member, workspace, email, name or IP.
 */
import {
  createTelemetryClient,
  type PostHogSender,
  type TelemetryClient,
} from '@antseed/telemetry'
import { GATEWAY_EVENT_CATALOG } from './catalog.js'
import {
  TELEMETRY_DOCS_URL,
  posthogConfig,
  readTelemetryState,
  resolveCliConsent,
  updateTelemetryState,
  walletAddress,
} from './settings.js'
import type { AuditRecord } from '../gateway/store.js'
import { detectInstallMethod } from '../update/install-method.js'
import pkg from '../../package.json' with { type: 'json' }

export type GatewayStep =
  | 'gateway_started'
  | 'console_claimed'
  | 'workspace_created'
  | 'key_created'
  | 'member_invited'
  | 'invite_accepted'
  | 'signed_in'

const STEP_BY_AUDIT_ACTION: Readonly<Record<string, GatewayStep>> = {
  'auth.setup_claim': 'console_claimed',
  'workspace.create': 'workspace_created',
  'key.create': 'key_created',
  'invite.create': 'member_invited',
  'auth.invite_accept': 'invite_accepted',
  'auth.sign_in': 'signed_in',
}

/** The funnel step an audit entry marks, or null for every other action. */
export function gatewayStepForAudit(action: string): GatewayStep | null {
  return STEP_BY_AUDIT_ACTION[action] ?? null
}

export type GatewayTelemetryOptions = {
  configPath: string
  dataDir: string
  onLog?: (message: string) => void
  env?: NodeJS.ProcessEnv
  /** Test seam. */
  sender?: PostHogSender
  /** Test seam: forces consent on. */
  forceEnabled?: boolean
  nowMs?: () => number
}

/** Every method is safe to call when telemetry is off, and never throws. */
export class GatewayTelemetry {
  private readonly _client: TelemetryClient
  private readonly _env: NodeJS.ProcessEnv
  private readonly _now: () => number
  private _distinctId: string | null = null
  private _ready: Promise<void> | null = null
  private readonly _pending = new Set<Promise<void>>()

  constructor(private readonly _options: GatewayTelemetryOptions) {
    this._env = _options.env ?? process.env
    this._now = _options.nowMs ?? (() => Date.now())
    this._client = createTelemetryClient({
      product: 'gateway',
      appVersion: pkg.version,
      installSource: detectInstallMethod({ env: this._env }).kind,
      catalog: GATEWAY_EVENT_CATALOG,
      // The gateway's default wallet: the same identity its buyer runs with, so both join.
      getDistinctId: () => this._distinctId,
      isEnabled: () => this.enabled,
      ...(_options.sender ? { sender: _options.sender } : { posthog: posthogConfig(this._env) }),
      nowMs: this._now,
    })
  }

  /** Read live, so `antseed telemetry disable` or the console toggle applies without a restart. */
  get enabled(): boolean {
    if (this._options.forceEnabled) return true
    try {
      return resolveCliConsent(this._options.configPath, this._env).enabled
    } catch {
      return false
    }
  }

  /** Reads the wallet, shows the one-time notice and sends `gateway_started`. */
  start(): Promise<void> {
    this._ready ??= (async () => {
      try {
        this._distinctId = await walletAddress(this._options.dataDir)
        if (!this.enabled) return
        if (readTelemetryState(this._options.dataDir).gatewayNoticeShownAt === undefined) {
          this._options.onLog?.(
            'anonymous usage data is on (setup steps and request outcomes; no keys, members or prompts). '
            + `Turn it off in the console's Settings, with \`antseed telemetry disable\` or ANTSEED_TELEMETRY=0. Details: ${TELEMETRY_DOCS_URL}`,
          )
          updateTelemetryState(this._options.dataDir, { gatewayNoticeShownAt: this._now() })
        }
        this._send('gateway_started')
      } catch {
        // Telemetry never affects the gateway.
      }
    })()
    return this._ready
  }

  /** The store's audit observer: sends the step an entry marks, if any. */
  observeAudit(record: Pick<AuditRecord, 'action'>): void {
    try {
      const step = gatewayStepForAudit(record.action)
      if (step) this._send(step)
    } catch {
      // Telemetry never affects the action it observes.
    }
  }

  private _send(step: GatewayStep): void {
    if (!this.enabled) return
    if (this._distinctId) {
      this._client.capture('gateway_step', { step })
      return
    }
    // A fresh gateway whose buyer creates the wallet after this process read it,
    // or a CLI command that has not read it yet: read it now.
    const at = this._now()
    const pending: Promise<void> = walletAddress(this._options.dataDir).then((address) => {
      this._distinctId ??= address
      this._client.capture('gateway_step', { step }, at)
    }).catch(() => {}).finally(() => { this._pending.delete(pending) })
    this._pending.add(pending)
  }

  async stop(timeoutMs = 750): Promise<void> {
    try {
      await Promise.all(this._pending)
      await this._client.close(timeoutMs)
    } catch {
      // Shutdown goes on.
    }
  }
}

/**
 * Setup steps taken with gateway CLI commands (`antseed gateway key create`,
 * `workspace create`, `member invite`, ...): each command opens its own store,
 * which the running gateway's observer never sees, so the command reports its
 * own step. Only once a gateway has started on this data dir with telemetry on
 * (its one-time notice was shown), so a command never sends before that.
 * Returns the function that sends what is queued before the command exits, or
 * null when nothing is observed.
 */
export function observeCliGatewayAudit(
  store: { setAuditObserver(observer: ((record: AuditRecord) => void) | null): void },
  options: Pick<GatewayTelemetryOptions, 'configPath' | 'dataDir' | 'env' | 'sender'>,
): (() => Promise<void>) | null {
  try {
    if (readTelemetryState(options.dataDir).gatewayNoticeShownAt === undefined) return null
    const telemetry = new GatewayTelemetry(options)
    if (!telemetry.enabled) return null
    store.setAuditObserver((record) => telemetry.observeAudit(record))
    return () => telemetry.stop()
  } catch {
    return null
  }
}
