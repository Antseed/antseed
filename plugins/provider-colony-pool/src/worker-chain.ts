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
 * The Channels client a worker verifies requests with: the chain's own RPC and
 * its fallbacks, so one endpoint failing does not refuse every paid request. An
 * operator's `--rpc-url` replaces both, as elsewhere in Antseed: its fallbacks
 * would be the chain default's, not the operator's.
 */
export function workerChannelsClient(
  chainId: string,
  rpcUrl?: string,
  channelsAddress?: string,
  chains: Record<string, WorkerChain | undefined> = CHAIN_CONFIGS as Record<string, WorkerChain | undefined>,
): ChannelsClient {
  const chain = chains[chainId];
  if (!chain) throw new Error(`Unknown --chain-id ${chainId}`);
  const fallbacks = rpcUrl ? [] : chain.fallbackRpcUrls ?? [];
  return new ChannelsClient({
    rpcUrl: rpcUrl ?? chain.rpcUrl,
    contractAddress: channelsAddress ?? chain.channelsContractAddress,
    evmChainId: chain.evmChainId,
    ...(fallbacks.length > 0 ? { fallbackRpcUrls: fallbacks } : {}),
  });
}

/** The Channels deployment buyers sign SpendingAuths for: the one this worker reads channels on. */
export function workerChannelsDomain(
  chainId: string,
  channelsAddress?: string,
  chains: Record<string, WorkerChain | undefined> = CHAIN_CONFIGS as Record<string, WorkerChain | undefined>,
): ChannelsDomain {
  const chain = chains[chainId];
  if (!chain) throw new Error(`Unknown --chain-id ${chainId}`);
  return { chainId: chain.evmChainId, channelsAddress: channelsAddress ?? chain.channelsContractAddress };
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

/**
 * Reads a pool contract's settlement of a channel and its credit to a worker
 * there, on the same RPC endpoints the worker reads channels with.
 */
export function workerPoolCreditReader(
  chainId: string,
  rpcUrl?: string,
  chains: Record<string, WorkerChain | undefined> = CHAIN_CONFIGS as Record<string, WorkerChain | undefined>,
): PoolCreditReader {
  const chain = chains[chainId];
  if (!chain) throw new Error(`Unknown --chain-id ${chainId}`);
  const fallbacks = rpcUrl ? [] : chain.fallbackRpcUrls ?? [];
  const clients = new Map<string, ColonyPoolClient>();
  return async (pool, channel, worker) => {
    let client = clients.get(pool.toLowerCase());
    if (!client) {
      client = new ColonyPoolClient({
        rpcUrl: rpcUrl ?? chain.rpcUrl,
        contractAddress: pool,
        evmChainId: chain.evmChainId,
        ...(fallbacks.length > 0 ? { fallbackRpcUrls: fallbacks } : {}),
      });
      clients.set(pool.toLowerCase(), client);
    }
    const [settled, credited] = await Promise.all([client.channelCumulative(channel), client.workerCumulative(channel, worker)]);
    return { settled, credited };
  };
}
