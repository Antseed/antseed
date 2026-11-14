import { CHAIN_CONFIGS, ChannelsClient } from '@antseed/node';
import { ColonyPoolClient } from '@antseed/node/payments';
import type { ChannelsDomain } from '@antseed/node/worker-e2e';
import { trustedChannelVerifier, type ChannelVerifier, type PoolCreditReader } from './worker.js';

export interface WorkerChain {
  channelsContractAddress: string;
  evmChainId: number;
  rpcUrl: string;
  fallbackRpcUrls?: string[];
}

/**
 * The chain's RPC endpoints a worker reads with: the chain's own RPC and its
 * fallbacks, so one endpoint failing does not refuse every paid request. An
 * operator's `--rpc-url` replaces both, as elsewhere in Antseed: its fallbacks
 * would be the chain default's, not the operator's.
 */
function resolveWorkerChain(chainId: string, rpcUrl: string | undefined, chains: Record<string, WorkerChain | undefined>) {
  const chain = chains[chainId];
  if (!chain) throw new Error(`Unknown --chain-id ${chainId}`);
  const fallbacks = rpcUrl ? [] : chain.fallbackRpcUrls ?? [];
  return {
    channelsAddress: chain.channelsContractAddress,
    evmChainId: chain.evmChainId,
    rpc: {
      rpcUrl: rpcUrl ?? chain.rpcUrl,
      evmChainId: chain.evmChainId,
      ...(fallbacks.length > 0 ? { fallbackRpcUrls: fallbacks } : {}),
    },
  };
}

/** The Channels client a worker verifies requests with. */
export function workerChannelsClient(
  chainId: string,
  rpcUrl?: string,
  channelsAddress?: string,
  chains: Record<string, WorkerChain | undefined> = CHAIN_CONFIGS as Record<string, WorkerChain | undefined>,
): ChannelsClient {
  const resolved = resolveWorkerChain(chainId, rpcUrl, chains);
  return new ChannelsClient({ ...resolved.rpc, contractAddress: channelsAddress ?? resolved.channelsAddress });
}

/** The Channels deployment buyers sign SpendingAuths for: the one this worker reads channels on. */
export function workerChannelsDomain(
  chainId: string,
  channelsAddress?: string,
  chains: Record<string, WorkerChain | undefined> = CHAIN_CONFIGS as Record<string, WorkerChain | undefined>,
): ChannelsDomain {
  const resolved = resolveWorkerChain(chainId, undefined, chains);
  return { chainId: resolved.evmChainId, channelsAddress: channelsAddress ?? resolved.channelsAddress };
}

/**
 * Reads channels from the chain's Channels contract, as this worker's own
 * config names it: never through a contract the pool points at.
 */
export function workerChannelVerifier(
  chainId: string,
  rpcUrl?: string,
  channelsAddress?: string,
  chains?: Record<string, WorkerChain | undefined>,
): ChannelVerifier {
  const client = workerChannelsClient(chainId, rpcUrl, channelsAddress, chains);
  return trustedChannelVerifier((channel) => client.getSession(channel));
}

/** The pool contract `pool` on the worker's chain, read through its RPC endpoints. */
export function workerPoolClient(
  chainId: string,
  pool: string,
  rpcUrl?: string,
  chains: Record<string, WorkerChain | undefined> = CHAIN_CONFIGS as Record<string, WorkerChain | undefined>,
): ColonyPoolClient {
  return new ColonyPoolClient({ ...resolveWorkerChain(chainId, rpcUrl, chains).rpc, contractAddress: pool });
}

/**
 * Reads a pool contract's settlement of a channel and its credit to a worker
 * there, in one call (`workerCredit`), on the same RPC endpoints the worker
 * reads channels with.
 */
export function workerPoolCreditReader(
  chainId: string,
  rpcUrl?: string,
  chains: Record<string, WorkerChain | undefined> = CHAIN_CONFIGS as Record<string, WorkerChain | undefined>,
): PoolCreditReader {
  const clients = new Map<string, ColonyPoolClient>();
  return (pool, channel, worker) => {
    let client = clients.get(pool.toLowerCase());
    if (!client) {
      client = workerPoolClient(chainId, pool, rpcUrl, chains);
      clients.set(pool.toLowerCase(), client);
    }
    return client.workerCredit(channel, worker);
  };
}
