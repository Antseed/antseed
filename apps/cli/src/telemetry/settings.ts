/**
 * Consent and PostHog config for the buyer (the gateway's buyer included) and
 * the gateway's setup funnel, the only parts of the CLI that send telemetry,
 * plus the gateway's first-run notice. The choice lives in the config file as
 * `telemetry.enabled` (the buyer and the gateway re-read it, so a change
 * applies live). The gateway's notice state lives in `<dataDir>/telemetry.json`.
 * Neither holds anything that identifies a user.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileIdentityStore } from '@antseed/node'
import {
  normalizeDistinctId,
  resolveConsent,
  resolvePostHogConfig,
  type ConsentDecision,
  type PostHogConfig,
} from '@antseed/telemetry'
import { BAKED_POSTHOG_HOST, BAKED_POSTHOG_PROJECT_API_KEY } from '../generated/baked-defaults.js'
import { patchConfigFile } from '../config/patch.js'

export const TELEMETRY_DOCS_URL = 'https://github.com/AntSeed/antseed/blob/main/docs/telemetry.md'
const STATE_FILE = 'telemetry.json'

export function posthogConfig(env: NodeJS.ProcessEnv = process.env): PostHogConfig | null {
  return resolvePostHogConfig(env, { host: BAKED_POSTHOG_HOST, projectApiKey: BAKED_POSTHOG_PROJECT_API_KEY })
}

/** `telemetry.enabled` from the raw config file; undefined when unset or unreadable. */
export function readConfiguredTelemetry(configPath: string): boolean | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const telemetry = (parsed as Record<string, unknown>)['telemetry']
    if (!telemetry || typeof telemetry !== 'object') return undefined
    const enabled = (telemetry as Record<string, unknown>)['enabled']
    return typeof enabled === 'boolean' ? enabled : undefined
  } catch {
    return undefined
  }
}

/**
 * Sets `telemetry.enabled` in the config file through `patchConfigFile`, the
 * same writer as the gateway console and `antseed config set`: only this key
 * changes, under the config lock, keeping the file's mode and writing through
 * a symlinked config to its target.
 */
export async function writeConfiguredTelemetry(configPath: string, enabled: boolean): Promise<void> {
  await patchConfigFile(configPath, (config) => {
    const current = config['telemetry']
    const telemetry = current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {}
    config['telemetry'] = { ...telemetry, enabled }
  })
}

export function resolveCliConsent(configPath: string, env: NodeJS.ProcessEnv = process.env): ConsentDecision {
  const persisted = readConfiguredTelemetry(configPath)
  return resolveConsent({
    env,
    configured: posthogConfig(env) !== null,
    ...(persisted !== undefined ? { persisted } : {}),
  })
}

type TelemetryState = { gatewayNoticeShownAt?: number }

export function readTelemetryState(dataDir: string): TelemetryState {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as TelemetryState : {}
  } catch {
    return {}
  }
}

export function updateTelemetryState(dataDir: string, patch: TelemetryState): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, STATE_FILE)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...readTelemetryState(dataDir), ...patch }), 'utf8')
    renameSync(tmp, file)
  } catch {
    // A notice shown twice is better than a command that fails.
  }
}

/** The data dir's wallet address (read without the passphrase), or null. */
export async function walletAddress(dataDir: string): Promise<string | null> {
  try {
    return normalizeDistinctId(await new FileIdentityStore(dataDir, { passphrase: null }).address())
  } catch {
    return null
  }
}
