export interface BootstrapNode {
  host: string;
  port: number;
  label?: string;
}

export const OFFICIAL_BOOTSTRAP_NODES: BootstrapNode[] = [
  { host: "dht1.antseed.com", port: 6881, label: "AntSeed-1" },
  { host: "dht2.antseed.com", port: 6881, label: "AntSeed-2" },
];

/**
 * Public BitTorrent DHT routers. Antseed nodes join through them only while they
 * know no DHT node at all (see `DHTNodeConfig.fallbackBootstrapNodes`); in normal
 * operation a routing table filled from them finds fewer Antseed peers.
 */
export const PUBLIC_FALLBACK_BOOTSTRAP_NODES: BootstrapNode[] = [
  { host: "router.bittorrent.com", port: 6881 },
  { host: "router.utorrent.com", port: 6881 },
  { host: "dht.transmissionbt.com", port: 6881 },
];

export function parseBootstrapList(entries: string[]): BootstrapNode[] {
  return entries.map((entry) => {
    const lastColon = entry.lastIndexOf(":");
    if (lastColon === -1) {
      throw new Error(`Invalid bootstrap entry, missing port: "${entry}"`);
    }

    const host = entry.slice(0, lastColon);
    const portStr = entry.slice(lastColon + 1);
    const port = parseInt(portStr, 10);

    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port in bootstrap entry: "${entry}"`);
    }

    return { host, port };
  });
}

export function mergeBootstrapNodes(
  official: BootstrapNode[],
  userConfigured: BootstrapNode[]
): BootstrapNode[] {
  const seen = new Set<string>();
  const result: BootstrapNode[] = [];

  for (const node of [...official, ...userConfigured]) {
    const key = `${node.host}:${node.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(node);
    }
  }

  return result;
}

export function toBootstrapConfig(
  nodes: BootstrapNode[]
): Array<{ host: string; port: number }> {
  return nodes.map((n) => ({ host: n.host, port: n.port }));
}
