/**
 * Gateway telemetry: that a gateway runs, how widely it listens, how many
 * workspaces, keys and members it has (as buckets), and x402 top-up
 * outcomes. Never a key, member, workspace or end-user identifier, and no
 * GeoIP: a gateway's IP is where the team hosts it, not where users are.
 */
import {
  TELEMETRY_HOST_ENV,
  TELEMETRY_HOST_SESSION_ID_ENV,
  countBucket,
  createTelemetryClient,
  usdcAmountBucket,
  type PostHogSender,
  type TelemetryClient,
} from '@antseed/telemetry'
import { CLI_EVENT_CATALOG } from './catalog.js'
import type { AddressScope } from '../gateway/exposure.js'
import {
  TELEMETRY_DOCS_URL,
  posthogConfig,
  readTelemetryState,
  resolveCliConsent,
  updateTelemetryState,
  walletAddress,
} from './settings.js'
import { detectInstallMethod } from '../update/install-method.js'
import pkg from '../../package.json' with { type: 'json' }

const DAY_MS = 24 * 60 * 60 * 1000

export type GatewayCounts = { workspaces: number; keys: number; members: number }

export type GatewayTelemetryOptions = {
  configPath: string
  dataDir: string
  listenExposure: AddressScope
  consoleEnabled: boolean
  x402Enabled: boolean
  counts: () => GatewayCounts
  onLog?: (message: string) => void
  env?: NodeJS.ProcessEnv
  sender?: PostHogSender
  forceEnabled?: boolean
  nowMs?: () => number
  dailyIntervalMs?: number
}

export class GatewayTelemetry {
  private readonly _client: TelemetryClient
  private readonly _env: NodeJS.ProcessEnv
  private readonly _now: () => number
  private _distinctId: string | null = null
  private _dailyTimer: NodeJS.Timeout | null = null
  private readonly _startedAt: number

  constructor(private readonly _options: GatewayTelemetryOptions) {
    this._env = _options.env ?? process.env
    this._now = _options.nowMs ?? (() => Date.now())
    this._startedAt = this._now()
    this._client = createTelemetryClient({
      product: 'gateway',
      appVersion: pkg.version,
      installSource: detectInstallMethod({ env: this._env }).kind,
      catalog: CLI_EVENT_CATALOG,
      getDistinctId: () => this._distinctId,
      isEnabled: () => this.enabled,
      ...(_options.sender ? { sender: _options.sender } : { posthog: posthogConfig(this._env) }),
      geoip: false,
      nowMs: this._now,
    })
  }

  /** Read live, so `antseed telemetry disable` or the console toggle applies without a restart. */
  get enabled(): boolean {
    if (this._options.forceEnabled) return true
    return resolveCliConsent(this._options.configPath, this._env).enabled
  }

  /** The session the gateway's buyer reports under. */
  get sessionId(): string {
    return this._client.sessionId
  }

  /** Env for the buyer this gateway runs: tags its events so it sends only the requests that matter for the journey. */
  buyerEnv(): Record<string, string> {
    return { [TELEMETRY_HOST_ENV]: 'gateway', [TELEMETRY_HOST_SESSION_ID_ENV]: this._client.sessionId }
  }

  private _counts(): Record<string, string> {
    try {
      const counts = this._options.counts()
      return {
        workspace_count_bucket: countBucket(counts.workspaces),
        key_count_bucket: countBucket(counts.keys),
        member_count_bucket: countBucket(counts.members),
      }
    } catch {
      return {}
    }
  }

  async start(): Promise<void> {
    try {
      this._distinctId = await walletAddress(this._options.dataDir)
      if (!this.enabled) return
      const state = readTelemetryState(this._options.dataDir)
      if (state.gatewayNoticeShownAt === undefined) {
        this._options.onLog?.(
          'anonymous usage data is on (counts and outcomes only; no keys, members, prompts or locations). '
          + `Turn it off with \`antseed telemetry disable\` or ANTSEED_TELEMETRY=0. Details: ${TELEMETRY_DOCS_URL}`,
        )
        updateTelemetryState(this._options.dataDir, { gatewayNoticeShownAt: this._now() })
      }
      this._client.capture('gateway_started', {
        listen_exposure: this._options.listenExposure,
        console_enabled: this._options.consoleEnabled,
        x402_enabled: this._options.x402Enabled,
        ...this._counts(),
      })
      this._dailyTimer = setInterval(() => this._daily(), this._options.dailyIntervalMs ?? DAY_MS)
      this._dailyTimer.unref?.()
    } catch {
      // Telemetry never affects the gateway.
    }
  }

  private _daily(): void {
    this._client.capture('gateway_daily', {
      ...this._counts(),
      uptime_days: Math.min(3_650, Math.floor((this._now() - this._startedAt) / DAY_MS)),
    })
  }

  topup(outcome: 'settled' | 'rejected' | 'failed', amountBaseUnits?: bigint): void {
    this._client.capture('gateway_topup', {
      outcome,
      ...(amountBaseUnits !== undefined ? { amount_bucket: usdcAmountBucket(amountBaseUnits) } : {}),
    })
  }

  async stop(timeoutMs = 750): Promise<void> {
    if (this._dailyTimer) {
      clearInterval(this._dailyTimer)
      this._dailyTimer = null
    }
    await this._client.close(timeoutMs)
  }
}
