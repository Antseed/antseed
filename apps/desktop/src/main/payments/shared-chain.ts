/**
 * One long-lived chain context for the desktop main process.
 *
 * Every balance, channel and rewards read goes through the same
 * `RotatingJsonRpcProvider` (the one the staking dashboard uses) instead of
 * each refresh building its own ethers `FallbackProvider` over every endpoint.
 * The endpoints are ranked once per session, concurrent identical reads are
 * shared, and an endpoint that rate limits is cooled down for every caller.
 * The resolved contract stack (registry pointers, epoch timing) is cached
 * for a few minutes rather than re-read on every rewards refresh.
 *
 * `resetSharedChain()` drops it when chain config changes.
 */
import { AntsContext, type AntsChainConfig } from '@antseed/ants/service';
import { ZeroAddress, type AbstractProvider } from 'ethers';
import { readConfig } from '../runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { resolveStakingChain } from '../staking/configuration.js';

/** Registry pointers and epoch timing change rarely; the rewards tile can lag them by a few minutes. */
export const SHARED_STACK_TTL_MS = 5 * 60_000;

type SharedChain = { key: string; context: Promise<AntsContext> };

let shared: SharedChain | null = null;

function chainKey(chain: AntsChainConfig): string {
  return JSON.stringify(chain);
}

/** The shared context for `chain`, built (and its endpoints ranked) on first use. */
export function sharedChainContext(chain: AntsChainConfig): Promise<AntsContext> {
  const key = chainKey(chain);
  if (shared?.key === key) return shared.context;
  const entry: SharedChain = {
    key,
    context: (async () => {
      const context = new AntsContext({ chain, address: ZeroAddress, stackTtlMs: SHARED_STACK_TTL_MS });
      await context.selectRpc();
      return context;
    })(),
  };
  shared = entry;
  // A failed setup must not pin the error for the session.
  entry.context.catch(() => { if (shared === entry) shared = null; });
  return entry.context;
}

export type ChainEndpoints = { rpcUrl: string; fallbackRpcUrls?: string[]; chainId?: number };

function sameEndpoints(chain: AntsChainConfig, endpoints: ChainEndpoints): boolean {
  const a = [chain.rpcUrl, ...(chain.fallbackRpcUrls ?? [])].sort();
  const b = [endpoints.rpcUrl, ...(endpoints.fallbackRpcUrls ?? [])].sort();
  return (endpoints.chainId === undefined || endpoints.chainId === chain.evmChainId)
    && a.length === b.length && a.every((url, index) => url === b[index]);
}

/**
 * The shared provider for the active VPR config, or null when that config
 * cannot back one or names other endpoints than `endpoints` (callers then
 * keep the provider their client built, as before).
 */
export async function sharedChainProvider(endpoints: ChainEndpoints): Promise<AbstractProvider | null> {
  try {
    const chain = resolveStakingChain(await readConfig(ACTIVE_CONFIG_PATH));
    if (!sameEndpoints(chain, endpoints)) return null;
    return (await sharedChainContext(chain)).provider();
  } catch {
    return null;
  }
}

/** Forget cached wallet reads (after a claim or stake) while keeping the ranked endpoints and stack. */
export function invalidateSharedChainReads(): void {
  void shared?.context.then((context) => context.invalidate({ walletOnly: true }), () => {});
}

/** Drop the shared context; the next read builds one for the current config. */
export function resetSharedChain(): void {
  shared = null;
}

/**
 * Route `client` through the shared provider when it serves the same
 * endpoints; otherwise leave the client on its own provider.
 */
export async function withSharedProvider<T extends { withProvider(provider: AbstractProvider): T }>(
  client: T,
  endpoints: ChainEndpoints,
): Promise<T> {
  const provider = await sharedChainProvider(endpoints);
  return provider ? client.withProvider(provider) : client;
}
