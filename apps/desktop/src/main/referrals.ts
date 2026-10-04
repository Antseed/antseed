/**
 * First-run referral confirmation.
 *
 * The download proxy remembers (for 48h, keyed by an HMAC of the network
 * address) which referrer wallet a download link carried. On first run we
 * ask that endpoint for a candidate, show it to the user, and store their
 * answer in `<connect data dir>/referral.json`. The buyer daemon reads that
 * file and appends the accepted referrer to every settlement metadata blob it
 * signs; AntseedStats binds it on-chain at the first settlement that carries
 * it. Nothing is signed or sent on-chain from here.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAddress, ZeroAddress } from 'ethers';
import { ReferralsClient } from '@antseed/node';
import { getSecureIdentity } from './identity.js';
import { loadCachedCryptoConfig } from './payments/credits.js';
import { resolveConnectDataDir } from './runtime/process-manager.js';

export type ReferralConfidence = 'probable' | 'low';
export type ReferralSetupStatus = {
  state: 'none' | 'candidate' | 'declined' | 'accepted' | 'bound' | 'error';
  referrer?: string;
  confidence?: ReferralConfidence;
  error?: string;
};

type StoredReferralState = {
  state: 'none' | 'candidate' | 'accepted' | 'declined' | 'bound';
  referrer?: string;
  confidence?: ReferralConfidence;
  updatedAt?: string;
};

const MATCH_URL = process.env.ANTSEED_REFERRAL_MATCH_URL ?? 'https://download.antseed.com/referral/match';
const NO_REFERRAL: ReferralSetupStatus = { state: 'none' };

function statePath(): string {
  return path.join(resolveConnectDataDir(), 'referral.json');
}

function normalizeReferrer(value: string | undefined): string | null {
  try {
    return getAddress(value?.trim() ?? '');
  } catch {
    return null;
  }
}

async function readState(): Promise<StoredReferralState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as StoredReferralState;
    return parsed && typeof parsed.state === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function saveState(state: StoredReferralState): Promise<StoredReferralState> {
  const filePath = statePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  const body = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(temporaryPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  return state;
}

async function referralsClient(): Promise<ReferralsClient | null> {
  const config = await loadCachedCryptoConfig();
  if (!config?.referralsAddress) return null;
  return new ReferralsClient({
    rpcUrl: config.rpcUrl,
    ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
    contractAddress: config.referralsAddress,
    evmChainId: config.chainId,
  });
}

/** On-chain referrer of this install's buyer wallet, or null when unbound / unknown. */
async function boundReferrer(client: ReferralsClient): Promise<string | null> {
  const identity = getSecureIdentity();
  if (!identity) return null;
  try {
    const bound = await client.referrerOf(identity.wallet.address);
    return bound && bound !== ZeroAddress ? getAddress(bound) : null;
  } catch {
    return null;
  }
}

export async function getReferralSetupStatus(): Promise<ReferralSetupStatus> {
  const client = await referralsClient();
  // Referrals are dark on this network: never show the card.
  if (!client) return NO_REFERRAL;

  const stored = await readState();
  if (stored?.state === 'accepted') {
    const bound = await boundReferrer(client);
    return bound ? saveState({ state: 'bound', referrer: bound }) : stored;
  }
  if (stored) return stored;

  try {
    const response = await fetch(MATCH_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return NO_REFERRAL;
    const payload = await response.json() as {
      match?: { referrer?: string; confidence?: ReferralConfidence } | null;
    };
    const referrer = normalizeReferrer(payload.match?.referrer);
    // A definitive "no match" is remembered: each match consumes the
    // network's single-use candidate, so an install must ask only once or it
    // would take candidates meant for new installs on the same network.
    if (!referrer) return await saveState({ state: 'none' });
    return await saveState({
      state: 'candidate',
      referrer,
      confidence: payload.match?.confidence === 'low' ? 'low' : 'probable',
    });
  } catch {
    return NO_REFERRAL;
  }
}

export async function declineReferral(): Promise<ReferralSetupStatus> {
  return saveState({ state: 'declined' });
}

export async function acceptReferral(rawReferrer: string): Promise<ReferralSetupStatus> {
  const referrer = normalizeReferrer(rawReferrer);
  if (!referrer) return { state: 'error', error: 'Invalid referrer wallet.' };
  try {
    const client = await referralsClient();
    if (!client) throw new Error('Referrals are not configured for this network.');
    const identity = getSecureIdentity();
    if (identity && identity.wallet.address.toLowerCase() === referrer.toLowerCase()) {
      throw new Error('A wallet cannot refer itself.');
    }
    const bound = await boundReferrer(client);
    return await saveState(bound ? { state: 'bound', referrer: bound } : { state: 'accepted', referrer });
  } catch (error) {
    return { state: 'error', referrer, error: error instanceof Error ? error.message : String(error) };
  }
}
