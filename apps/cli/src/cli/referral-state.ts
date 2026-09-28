import { readFile, rename, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { ZeroAddress, getAddress } from 'ethers'
import { clientIdFromAgentId, type ReferralsClient } from '@antseed/node'

/**
 * Referral state shared between Desktop (which asks the user to confirm the
 * inviter during first-run setup) and the buyer daemon (which appends the
 * confirmed referrer to the metadata it signs, so AntseedStats binds it on
 * the first settlement that carries it). Lives at `<dataDir>/referral.json`.
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

/** First-party client kinds with an ERC-8004 agent id in chain config. */
export type ClientKind = 'cli' | 'desktop'

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
 *
 * The client is an ERC-8004 agent id: ANTSEED_CLIENT_AGENT_ID (third-party
 * clients), then `buyer.clientAgentId`, then the chain-config id for this
 * client kind (ANTSEED_CLIENT_KIND, set to "desktop" by Desktop; "cli"
 * otherwise). Without any of those the metadata carries no client word.
 */
export function resolveBuyerAttribution(options: {
  referralState: ReferralState | null
  clientAgentId?: number | undefined
  clientAgentIds?: { cli?: number; desktop?: number } | undefined
  env?: NodeJS.ProcessEnv
}): { referrer?: string; clientId?: string } {
  const env = options.env ?? process.env
  const referrer = pendingReferrer(options.referralState)
  const agentId = resolveClientAgentId(options, env)
  return {
    ...(referrer ? { referrer } : {}),
    ...(agentId ? { clientId: clientIdFromAgentId(agentId) } : {}),
  }
}

function resolveClientAgentId(
  options: { clientAgentId?: number | undefined; clientAgentIds?: { cli?: number; desktop?: number } | undefined },
  env: NodeJS.ProcessEnv,
): number | undefined {
  const fromEnv = Number.parseInt(env['ANTSEED_CLIENT_AGENT_ID'] ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  if (options.clientAgentId && options.clientAgentId > 0) return options.clientAgentId
  const kind: ClientKind = env['ANTSEED_CLIENT_KIND'] === 'desktop' ? 'desktop' : 'cli'
  const fromChain = options.clientAgentIds?.[kind]
  return fromChain && fromChain > 0 ? fromChain : undefined
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
