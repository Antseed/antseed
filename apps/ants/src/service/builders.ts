import { isError } from 'ethers';
import type { BuilderAgentView, BuildersView } from '../api-types.js';
import { compareBuilderAgents, MAX_BUILDER_AGENTS } from '../builders-view.js';
import type { AntsContext } from './context.js';
import { assertAgentId, silentReporter, type StepReporter } from './steps.js';

export { MAX_BUILDER_AGENTS };

/** ERC-8004 owner of `agentId`, or null when the id is not minted (ownerOf reverts). */
async function agentOwner(ctx: AntsContext, agentId: number): Promise<string | null> {
  const identity = ctx.identity();
  if (!identity) return null;
  try {
    return await identity.getAgentWallet(agentId);
  } catch (error) {
    if (isError(error, 'CALL_EXCEPTION')) return null;
    throw error;
  }
}

/**
 * Builders-program view for the requested client agent ids plus the chain's
 * first-party client ids this wallet owns. No registry call enumerates a
 * wallet's agents cheaply, so third-party builders name their ids. Payable
 * amounts come from Antscan; only agent ownership (`ownerOf`, which Antscan
 * does not index) is read over RPC. Hidden without an explorer that indexes
 * the builders program. Each request names at most `MAX_BUILDER_AGENTS` ids
 * (the card reads more in batches); a larger request is refused, never cut.
 */
export async function builders(ctx: AntsContext, agentIds: number[]): Promise<BuildersView> {
  const indexer = ctx.indexer();
  if (!ctx.chain.clientRewardsAddress || !indexer?.builders) return { available: false, agents: [] };
  const requested = [...new Set(agentIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (requested.length > MAX_BUILDER_AGENTS) throw new Error(`Request at most ${MAX_BUILDER_AGENTS} client agent ids at a time.`);
  const firstParty = new Map<number, 'cli' | 'desktop'>();
  for (const kind of ['cli', 'desktop'] as const) {
    const id = ctx.chain.clientAgentIds?.[kind];
    if (id) firstParty.set(id, kind);
  }
  const candidates = [...new Set([...requested, ...firstParty.keys()])];
  const [ownerEntries, indexed] = await Promise.all([
    Promise.all(candidates.map(async (id) => [id, await agentOwner(ctx, id)] as const)),
    indexer.builders(candidates),
  ]);
  if (!indexed.available) return { available: false, agents: [] };
  const owners = new Map(ownerEntries);
  const rewards = new Map(indexed.agents.map((agent) => [agent.agentId, agent]));
  const ownedByWallet = (id: number) => owners.get(id)?.toLowerCase() === ctx.address.toLowerCase();
  const shown = candidates.filter((id) => requested.includes(id) || ownedByWallet(id));
  const agents = shown.map((agentId): BuilderAgentView => ({
    agentId,
    owner: owners.get(agentId) ?? null,
    owned: ownedByWallet(agentId),
    firstParty: firstParty.get(agentId) ?? null,
    payable: rewards.get(agentId)?.payable ?? '0',
    claimableEpochs: rewards.get(agentId)?.claimableEpochs ?? [],
  }));
  agents.sort(compareBuilderAgents);
  return { available: true, agents };
}

/**
 * Claim every payable epoch for one client agent, one transaction per epoch
 * (the contract has no batch claim). Anyone may send it; the contract always
 * pays the agent owner. Epochs come from Antscan; when it is unset, does not
 * index the builders program, or is unreachable, the RPC epoch scan names them.
 * A successful indexed answer is authoritative, even when it lists no epochs.
 */
export async function claimBuilderRewards(
  ctx: AntsContext,
  agentIdInput: number,
  report: StepReporter = silentReporter,
): Promise<{ agentId: number; owner: string; epochs: number[]; hashes: string[] }> {
  const client = ctx.clientRewards();
  if (!client) throw new Error('The builders program is not configured for this chain.');
  const agentId = assertAgentId(agentIdInput);
  const signer = ctx.requireSigner();
  const owner = await agentOwner(ctx, agentId);
  if (!owner) throw new Error(`Agent ${agentId} is not registered in the ERC-8004 identity registry.`);
  const indexer = ctx.indexer();
  const indexed = indexer?.builders ? await indexer.builders([agentId]).catch(() => null) : null;
  const epochs = indexed?.available
    ? indexed.agents.find((agent) => agent.agentId === agentId)?.claimableEpochs ?? []
    : (await client.pendingRewards(agentId)).map((entry) => entry.epoch);
  if (epochs.length === 0) throw new Error(`No builder rewards are payable yet for agent ${agentId}.`);
  const hashes: string[] = [];
  for (const [index, epoch] of epochs.entries()) {
    await report(`Claiming epoch ${epoch} for agent ${agentId} (${index + 1} of ${epochs.length}), paid to ${owner}`);
    const hash = await client.claim(signer, agentId, epoch);
    hashes.push(hash);
    await report(`Epoch ${epoch} claimed`, hash);
  }
  return { agentId, owner, epochs, hashes };
}

/** Mint a new ERC-8004 agent owned by this wallet to identify a client app. */
export async function registerClientAgent(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ agentId: number }> {
  const signer = ctx.requireSigner();
  const identity = ctx.identity();
  if (!identity) throw new Error('The identity registry is not configured for this chain.');
  await report('Creating an ERC-8004 client agent');
  const agentId = assertAgentId(await identity.register(signer));
  await report(`Client agent created: agent ${agentId}. Send it as your app's clientId.`);
  ctx.invalidate();
  return { agentId };
}
