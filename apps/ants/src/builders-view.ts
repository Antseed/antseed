import type { BuilderAgentView, BuildersView } from './api-types.js';

/** Each agent costs an ownerOf read; one `/api/builders` request carries at most this many ids. */
export const MAX_BUILDER_AGENTS = 20;

/**
 * Builders card order: agents this wallet is paid for first (first-party
 * before user-added), then the rest; within a group, the largest payable
 * amount leads. Stable sorts keep request order for ties.
 */
export function compareBuilderAgents(a: BuilderAgentView, b: BuilderAgentView): number {
  const rank = (agent: BuilderAgentView) => (agent.owned ? (agent.firstParty ? 0 : 1) : 2);
  const diff = BigInt(b.payable) - BigInt(a.payable);
  return rank(a) - rank(b) || (diff > 0n ? 1 : diff < 0n ? -1 : 0);
}

/**
 * Builders view for every tracked id, read in batches of at most
 * `MAX_BUILDER_AGENTS` ids one after another, so no tracked agent is dropped
 * and each request stays bounded. First-party ids come back in every batch and
 * are kept once.
 */
export async function readBuildersInBatches(
  agentIds: number[],
  read: (batch: number[]) => Promise<BuildersView>,
): Promise<BuildersView> {
  const ids = [...new Set(agentIds)];
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += MAX_BUILDER_AGENTS) batches.push(ids.slice(i, i + MAX_BUILDER_AGENTS));
  if (batches.length === 0) batches.push([]); // still reads the first-party ids this wallet owns
  const agents = new Map<number, BuilderAgentView>();
  let indexed = true;
  for (const batch of batches) {
    const view = await read(batch);
    if (!view.available) return { available: false, indexed: false, agents: [] };
    indexed &&= view.indexed;
    for (const agent of view.agents) if (!agents.has(agent.agentId)) agents.set(agent.agentId, agent);
  }
  return { available: true, indexed, agents: [...agents.values()].sort(compareBuilderAgents) };
}
