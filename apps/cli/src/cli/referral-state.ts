import { readFile, rename, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { ZeroAddress, getAddress } from 'ethers'
import { clientIdFromLabel, type ReferralsClient } from '@antseed/node'

/**
 * Referral state shared between Desktop (which asks the user to confirm the
 * inviter during first-run setup) and the buyer daemon (which appends the
 * confirmed referrer to the metadata it signs, so AntseedStats binds it on
 * the first settlement). Lives at `<dataDir>/referral.json`.
 *
 *   candidate → accepted → bound
 *             ↘ declined
 */
export type ReferralState = {
  state: 'candidate' | 'accepted' | 'declined' | 'bound'
  referrer?: string
  confidence?: 'probable' | 'low'
  /** ISO timestamp of the last transition. */
  updatedAt?: string
}

export const DEFAULT_CLI_CLIENT_LABEL = 'antseed-cli'

export function referralStatePath(dataDir: string): string {
  return join(dataDir, 'referral.json')
}

export async function readReferralState(dataDir: string): Promise<ReferralState | null> {
  try {
    const parsed = JSON.parse(await readFile(referralStatePath(dataDir), 'utf8')) as ReferralState
    return parsed && typeof parsed.state === 'string' ? parsed : null
  } catch {
    return null
  }
}

export async function writeReferralState(dataDir: string, state: ReferralState): Promise<void> {
  const filePath = referralStatePath(dataDir)
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  const body = { ...state, updatedAt: new Date().toISOString() }
  await writeFile(temporaryPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryPath, filePath)
}

export async function referralStateMtimeMs(dataDir: string): Promise<number | null> {
  try {
    return (await stat(referralStatePath(dataDir))).mtimeMs
  } catch {
    return null
  }
}

/** Accepted-but-not-yet-bound referrer, checksummed; null otherwise. */
export function pendingReferrer(state: ReferralState | null): string | null {
  if (state?.state !== 'accepted' || !state.referrer) return null
  try {
    return getAddress(state.referrer)
  } catch {
    return null
  }
}

/**
 * Resolve the attribution the buyer appends to signed settlement metadata.
 * The client label comes from ANTSEED_CLIENT_ID (Desktop sets it), then the
 * buyer config, then the CLI default.
 */
export function resolveBuyerAttribution(options: {
  referralState: ReferralState | null
  clientLabel?: string | undefined
  env?: NodeJS.ProcessEnv
}): { referrer?: string; clientId: string } {
  const env = options.env ?? process.env
  const label = env['ANTSEED_CLIENT_ID']?.trim() || options.clientLabel?.trim() || DEFAULT_CLI_CLIENT_LABEL
  const referrer = pendingReferrer(options.referralState)
  return { ...(referrer ? { referrer } : {}), clientId: clientIdFromLabel(label) }
}

/**
 * Re-read the state file and, when an accepted referral is already bound
 * on-chain, record that so the daemon stops carrying the referrer.
 */
export async function syncReferralState(
  dataDir: string,
  buyer: string,
  client: ReferralsClient | null,
): Promise<ReferralState | null> {
  const state = await readReferralState(dataDir)
  if (state?.state !== 'accepted' || !client) return state
  const bound = await client.referrerOf(buyer).catch(() => null)
  if (!bound || bound === ZeroAddress) return state
  const boundState: ReferralState = { state: 'bound', referrer: bound }
  await writeReferralState(dataDir, boundState).catch(() => {})
  return boundState
}
