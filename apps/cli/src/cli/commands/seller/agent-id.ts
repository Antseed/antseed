import type { AbstractSigner } from 'ethers';
import type { IdentityClient } from '@antseed/node/payments';

type AgentIdOwnerLookup = Pick<IdentityClient, 'findOwnedAgentIds'>;

/** Called once when the registry log scan starts, then after each window scanned. */
export type RecoveryProgress = (progress?: { scannedDownTo: number; floor: number }) => void;

/**
 * Recover the agent ID a wallet holds from the identity registry's Transfer
 * logs (the registry is not enumerable). Returns undefined when the wallet
 * holds none. Never guesses: several agents throw with the list.
 */
export async function recoverAgentId(
  identity: AgentIdOwnerLookup,
  owner: string,
  onProgress?: RecoveryProgress,
): Promise<number | undefined> {
  onProgress?.();
  const agentIds = await identity.findOwnedAgentIds(owner, onProgress
    ? { onProgress: (scannedDownTo, floor) => onProgress({ scannedDownTo, floor }) }
    : {});
  if (agentIds.length > 1) {
    throw new Error(`This wallet holds several agent IDs (${agentIds.join(', ')}). Pass --agent-id <id> to choose one.`);
  }
  return agentIds[0];
}

export interface RegisterAgentIdDeps {
  identity: Pick<IdentityClient, 'isRegistered' | 'register' | 'findOwnedAgentIds'>;
  /** The agent ID the seller registry or staking contract already binds to this wallet (0 when none). */
  lookupBoundAgentId: () => Promise<number>;
  /** Prints a line as soon as it is known, before any later step can fail. */
  log: (line: string) => void;
  /** Called before the mint transaction is sent. */
  onMinting?: () => void;
  /** Reports the registry log scan, so the caller can say what it is waiting on. */
  onRecovering?: RecoveryProgress;
}

export interface RegisterAgentIdOptions {
  agentId?: number;
  metadata?: string;
  /** Recover from the registry logs when nothing else knows the ID. */
  requireAgentId: boolean;
}

/**
 * The identity step of `seller register`: mint when the wallet holds no agent,
 * otherwise find the existing agent ID. A fresh mint prints its agent ID the
 * moment the receipt lands, so a failure in a later step never strands it.
 */
export async function ensureRegisteredAgentId(
  deps: RegisterAgentIdDeps,
  wallet: AbstractSigner,
  address: string,
  options: RegisterAgentIdOptions,
): Promise<{ agentId?: number; minted: boolean }> {
  const { identity, log } = deps;
  if (!await identity.isRegistered(address)) {
    deps.onMinting?.();
    let agentId: number | undefined = await identity.register(wallet, options.metadata || undefined,
      (hash) => log(`Transaction: ${hash}`));
    if (!agentId) agentId = await recoverAgentId(identity, address, deps.onRecovering);
    if (agentId) log(`Agent ID: ${agentId}`);
    return { agentId, minted: true };
  }

  let agentId = options.agentId || await deps.lookupBoundAgentId() || undefined;
  if (!agentId && options.requireAgentId) agentId = await recoverAgentId(identity, address, deps.onRecovering);
  return { agentId, minted: false };
}

/**
 * The agent ID `seller legacy stake` stakes for: the one the staking contract
 * holds, else `--agent-id`, else the one the wallet holds in the registry.
 */
export async function resolveLegacyStakeAgentId(
  stakedAgentId: number,
  explicitAgentId: number | undefined,
  identity: AgentIdOwnerLookup,
  owner: string,
  onRecovering?: RecoveryProgress,
): Promise<number | undefined> {
  if (stakedAgentId) return stakedAgentId;
  if (explicitAgentId) return explicitAgentId;
  return recoverAgentId(identity, owner, onRecovering);
}

/** Spinner text for a registry log scan in progress. */
export function recoveryProgressText(progress?: { scannedDownTo: number; floor: number }): string {
  const base = 'Looking up your agent ID in the identity registry';
  return progress ? `${base} (scanned back to block ${progress.scannedDownTo}, stops at ${progress.floor})...` : `${base}...`;
}
