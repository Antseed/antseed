/**
 * What the connection diagnostics say about the network. A local gateway is
 * judged by its own process and this machine's view of the network; a remote
 * one has no local process or network view, only whether it answers.
 */
export type ConnectionHealth = {
  runtime: 'connected' | 'remote' | 'offline';
  /** The status line's network health. */
  health: string;
  /** Whether this machine's network view (DHT, peers) describes the connection. */
  localNetwork: boolean;
};

export function connectionHealth(
  gateway: { mode: 'local' | 'remote'; reachable: boolean } | null,
  localGatewayRunning: boolean,
  dhtLabel: string,
): ConnectionHealth {
  if (gateway?.mode === 'remote') {
    return gateway.reachable
      ? { runtime: 'remote', health: 'Remote gateway', localNetwork: false }
      : { runtime: 'offline', health: 'Offline', localNetwork: false };
  }
  // The main process keeps the last network snapshot after the gateway stops,
  // so a stopped one reads offline rather than its last health.
  return localGatewayRunning
    ? { runtime: 'connected', health: dhtLabel, localNetwork: true }
    : { runtime: 'offline', health: 'Offline', localNetwork: true };
}
