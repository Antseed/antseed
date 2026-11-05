/**
 * TCP relay that makes the loopback-only buyer proxy reachable from WSL.
 *
 * Under WSL2 NAT networking a distro cannot reach the Windows host's
 * 127.0.0.1; it can reach the host's address on the WSL virtual switch (its
 * default-route gateway). The buyer proxy deliberately binds only 127.0.0.1 —
 * it is keyless, so exposing it on 0.0.0.0 would let anyone on the LAN spend
 * the buyer's funds. Listening on the gateway address alone keeps the
 * exposure to the WSL subnet while giving distros a way in.
 */
import net from 'node:net';

const relays = new Map<string, net.Server>();

function relayKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function startRelay(host: string, port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(port, '127.0.0.1');
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
      resolve(server);
    });
  });
}

function closeRelay(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Reconcile running relays with the wanted host list: one relay per host on
 * `buyerPort`, forwarding to 127.0.0.1:`buyerPort`; anything else is closed.
 * A failed listen is reported and skipped — the other hosts still connect.
 */
export async function syncWslRelays(
  hosts: readonly string[],
  buyerPort: number,
  logLine?: (line: string) => void,
): Promise<void> {
  const wanted = new Set(hosts.map((host) => relayKey(host, buyerPort)));
  for (const [key, server] of [...relays]) {
    if (wanted.has(key)) continue;
    relays.delete(key);
    await closeRelay(server);
  }
  for (const host of new Set(hosts)) {
    const key = relayKey(host, buyerPort);
    if (relays.has(key)) continue;
    try {
      relays.set(key, await startRelay(host, buyerPort));
      logLine?.(`WSL relay listening on ${key} → 127.0.0.1:${buyerPort}`);
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
