/**
 * Consent, PostHog config and the first-run notice for the CLI, the buyer and
 * the gateway. The choice lives in the config file as `telemetry.enabled`
 * (the buyer watches that file, so a change applies live). Notice state lives
 * in `<dataDir>/telemetry.json`. Neither holds anything that identifies a user.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FileIdentityStore, identityEnvelopeAddress, identityFromPrivateKeyHex, isIdentityEnvelope } from '@antseed/node'
import {
  TELEMETRY_HOST_ENV,
  normalizeDistinctId,
  resolveConsent,
  resolvePostHogConfig,
  type ConsentDecision,
  type PostHogConfig,
} from '@antseed/telemetry'
import { BAKED_POSTHOG_HOST, BAKED_POSTHOG_PROJECT_API_KEY } from '../generated/baked-defaults.js'

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
 * Sets `telemetry.enabled` in the config file, leaving every other key as it
 * is (no defaults are written). Atomic, so a watching buyer never reads half a file.
 */
export function writeConfiguredTelemetry(configPath: string, enabled: boolean): void {
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${configPath} is not a JSON object`)
    }
    config = parsed as Record<string, unknown>
  }
  const current = config['telemetry'] && typeof config['telemetry'] === 'object' && !Array.isArray(config['telemetry'])
    ? config['telemetry'] as Record<string, unknown>
    : {}
  config['telemetry'] = { ...current, enabled }
  mkdirSync(dirname(configPath), { recursive: true })
  const tmp = `${configPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(tmp, configPath)
}

export function resolveCliConsent(configPath: string, env: NodeJS.ProcessEnv = process.env): ConsentDecision {
  const persisted = readConfiguredTelemetry(configPath)
  return resolveConsent({
    env,
    configured: posthogConfig(env) !== null,
    ...(persisted !== undefined ? { persisted } : {}),
  })
}

/** Started by the desktop or the gateway: they report for themselves. */
export function hostedByApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[TELEMETRY_HOST_ENV]?.trim())
}

type TelemetryState = { cliNoticeShownAt?: number; gatewayNoticeShownAt?: number }

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

export function cliNoticeText(): string {
  return [
    'AntSeed collects anonymous usage data (commands run, request outcomes, coarse timings) to improve the network.',
    'No prompts, answers, keys, peer IDs, exact amounts or arguments are sent.',
    `Turn it off with \`antseed telemetry disable\`, ANTSEED_TELEMETRY=0 or DO_NOT_TRACK=1. Details: ${TELEMETRY_DOCS_URL}`,
  ].join('\n')
}

/** The wallet address, read without decrypting anything; null when there is no usable key file. */
export async function walletAddress(dataDir: string): Promise<string | null> {
  try {
    return normalizeDistinctId(await new FileIdentityStore(dataDir, { passphrase: null }).address())
  } catch {
    return null
  }
}

/** Synchronous variant for exit handlers. */
export function walletAddressSync(dataDir: string): string | null {
  try {
    const stored = readFileSync(join(dataDir, 'identity.key'), 'utf8').trim()
    if (isIdentityEnvelope(stored)) return normalizeDistinctId(identityEnvelopeAddress(stored))
    if (!/^[0-9a-fA-F]{64}$/.test(stored)) return null
    return normalizeDistinctId(identityFromPrivateKeyHex(stored).wallet.address)
  } catch {
    return null
  }
}
