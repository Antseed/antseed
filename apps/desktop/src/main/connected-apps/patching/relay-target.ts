/**
 * Where a WSL relay must forward to: a gateway on this computer's loopback,
 * whoever runs it. Under WSL's NAT networking the distro can't reach loopback
 * directly. A gateway elsewhere is reachable as it is, so it needs no relay.
 */
export function relayTarget(origin: string | null | undefined): { port: number; upstreamHost: string } | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const ipv6 = host === '[::1]';
  if (host !== 'localhost' && !/^127\./.test(host) && !ipv6) return null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { port, upstreamHost: ipv6 ? '::1' : host === 'localhost' ? '127.0.0.1' : host };
}
