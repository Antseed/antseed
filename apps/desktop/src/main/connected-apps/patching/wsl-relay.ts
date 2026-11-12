/**
 * TCP relay that makes the loopback-only local gateway reachable from WSL.
 *
 * Under WSL2 NAT networking a distro cannot reach the Windows host's
 * 127.0.0.1; it can reach the host's address on the WSL virtual switch (its
 * default-route gateway). The gateway deliberately binds only 127.0.0.1, so
 * it isn't exposed to the LAN. Listening on the virtual switch address alone
 * keeps the exposure to the WSL subnet while giving distros a way in.
 */
import net from 'node:net';

type Relay = { server: net.Server; sockets: Set<net.Socket> };

const relays = new Map<string, Relay & { upstreamHost: string }>();

function relayKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function startRelay(host: string, port: number, upstreamHost: string): Promise<Relay> {
  const sockets = new Set<net.Socket>();
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(port, upstreamHost);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({ server, sockets });
    });
  });
}

/** Stops listening and drops open connections: a keep-alive client must not hold quit open. */
function closeRelay({ server, sockets }: Relay): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const socket of sockets) socket.destroy();
  return closed;
}

/**
 * Reconcile running relays with the wanted host list: one relay per host on
 * `buyerPort`, forwarding to `upstreamHost`:`buyerPort`; anything else is closed.
 * A failed listen is reported and skipped — the other hosts still connect.
 */
export async function syncWslRelays(
  hosts: readonly string[],
  buyerPort: number,
  logLine?: (line: string) => void,
  upstreamHost = '127.0.0.1',
): Promise<void> {
  const wanted = new Set(hosts.map((host) => relayKey(host, buyerPort)));
  for (const [key, relay] of [...relays]) {
    // A relay forwards to the host it was started with, so a new one replaces it.
    if (wanted.has(key) && relay.upstreamHost === upstreamHost) continue;
    relays.delete(key);
    await closeRelay(relay);
  }
  for (const host of new Set(hosts)) {
    const key = relayKey(host, buyerPort);
    if (relays.has(key)) continue;
    try {
      relays.set(key, { ...await startRelay(host, buyerPort, upstreamHost), upstreamHost });
      logLine?.(`WSL relay listening on ${key} → ${upstreamHost}:${buyerPort}`);
    } catch (err) {
      logLine?.(
        `WSL relay could not listen on ${key}: ${err instanceof Error ? err.message : String(err)} — `
        + 'tools inside WSL cannot reach the buyer proxy until this binds '
        + '(check that Windows Firewall allows the app on the vEthernet (WSL) network)',
      );
    }
  }
}

export async function stopWslRelays(): Promise<void> {
  await syncWslRelays([], 0);
}
