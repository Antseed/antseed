import type { NetworkCLIConfig } from './types.js';

export interface NetworkNodeOptions {
  dhtPort?: number;
  signalingPort?: number;
  bindHost?: string;
  natTraversal?: boolean;
  noOfficialBootstrap?: boolean;
  allowPrivateIPs?: boolean;
  dhtOperationTimeoutMs?: number;
}

/**
 * `AntseedNode` options from the `network` config section and the port flags
 * (a flag wins). A setting that is not given stays out, so the node's default
 * applies. Port 0 is a setting: it asks the OS for a free port.
 */
export function networkNodeOptions(
  network: NetworkCLIConfig,
  flags: { dhtPort?: number | undefined; signalingPort?: number | undefined } = {},
): NetworkNodeOptions {
  const port = (flag: number | undefined, configured: number | undefined): number | undefined =>
    Number.isInteger(flag) ? flag : configured;
  const dhtPort = port(flags.dhtPort, network.dhtPort);
  const signalingPort = port(flags.signalingPort, network.signalingPort);
  return {
    ...(dhtPort !== undefined ? { dhtPort } : {}),
    ...(signalingPort !== undefined ? { signalingPort } : {}),
    ...(network.bindHost !== undefined ? { bindHost: network.bindHost } : {}),
    ...(network.natTraversal !== undefined ? { natTraversal: network.natTraversal } : {}),
    ...(network.noOfficialBootstrap !== undefined ? { noOfficialBootstrap: network.noOfficialBootstrap } : {}),
    ...(network.allowPrivateIPs !== undefined ? { allowPrivateIPs: network.allowPrivateIPs } : {}),
    ...(network.dhtOperationTimeoutMs !== undefined ? { dhtOperationTimeoutMs: network.dhtOperationTimeoutMs } : {}),
  };
}
