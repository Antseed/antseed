/**
 * Shared `host:port` endpoint parsing for announced seller addresses.
 *
 * Single source of truth used by both config validation and the seller
 * reachability diagnostics so the accepted formats cannot drift.
 */
export interface HostPortEndpoint {
  host: string;
  port: number;
}

/**
 * Parse a `host:port` string. Accepts hostnames, IPv4, and bracketed IPv6
 * (`[2001:db8::1]:6882` — brackets are stripped from the returned host).
 * Returns null for anything without a valid host and a port in 1-65535.
 */
export function parseHostPort(value: string): HostPortEndpoint | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === trimmed.length - 1) return null;

  let host = trimmed.slice(0, lastColon).trim();
  const portText = trimmed.slice(lastColon + 1);
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host.length === 0 || !/^\d+$/.test(portText)) return null;

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}
