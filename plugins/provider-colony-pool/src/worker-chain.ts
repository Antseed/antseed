import { CHAIN_CONFIGS, ChannelsClient } from '@antseed/node';
import { trustedChannelVerifier, type ChannelVerifier } from './worker.js';

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
