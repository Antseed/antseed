/** Hosts a bearer key may reach without TLS: this computer and private networks. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ipv4) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return first === 127
    || first === 10
    || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 169 && second === 254)
    // Carrier-grade NAT, where overlay networks like Tailscale live.
    || (first === 100 && second >= 64 && second <= 127);
}

/** Normalizes a pasted gateway URL to its origin (`https://host[:port]`); throws when it is not one. */
export function normalizeGatewayUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Gateway URL must use http or https');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error('Use https for this gateway: over http its API key would travel unencrypted. http only works on this computer or a private network.');
  }
  return url.origin;
}
