/**
 * Reading back the Windows system proxy.
 *
 * WinINET apps take their proxy from `ProxyEnable`/`ProxyServer` under
 * HKCU Internet Settings, so those two values decide whether anything is
 * actually intercepted. Setting them is not proof they stuck — a VPN client,
 * corporate policy, or another proxy tool can overwrite them afterwards, and
 * the failure is silent: traffic just goes direct while the app still looks
 * connected. The parsing lives here, apart from the `reg` call, so the
 * decision itself is testable.
 */

/** One registry mutation: write a value, or remove it so the key falls back
    to "unset" (there is no other way to express an absent value). */
export type WindowsProxyRegistryWrite =
  | { name: string; type: 'REG_DWORD' | 'REG_SZ'; value: string }
  | { name: string; type: 'delete' };

/**
 * The registry writes that restoring a captured proxy snapshot implies.
 *
 * Split out from the `reg` calls because the interesting decision is a
 * silent-damage one: `ProxyOverride` (the bypass list) is only ours to put
 * back when the snapshot actually captured it. Snapshots written before the
 * bypass list existed have no such key, and a missing key means "we never
 * touched this", not "it was empty" — restoring `null` there would delete a
 * bypass list the user or their IT department set, which nothing else in the
 * app would ever surface.
 */
export function windowsProxyRestoreWrites(
  snapshot: Record<string, unknown>,
): WindowsProxyRegistryWrite[] {
  const stringOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value ? value : null;
  const restore = (name: string, value: unknown): WindowsProxyRegistryWrite => {
    const text = stringOrNull(value);
    return text ? { name, type: 'REG_SZ', value: text } : { name, type: 'delete' };
  };
  const writes: WindowsProxyRegistryWrite[] = [{
    name: 'ProxyEnable',
    type: 'REG_DWORD',
    // Anything unreadable restores to "off": leaving the proxy on is what
    // takes the machine offline, so that is the safe direction to fail.
    value: stringOrNull(snapshot['proxyEnable']) ?? '0',
  }];
  writes.push(restore('ProxyServer', snapshot['proxyServer']));
  if ('proxyOverride' in snapshot) {
    writes.push(restore('ProxyOverride', snapshot['proxyOverride']));
  }
  return writes;
}

/** A `reg query` line's value, e.g. "    ProxyEnable    REG_DWORD    0x1".
    Matched on the whole first column, not a prefix — `Proxy` must not read
    `ProxyEnable`'s value. Registry value names are case-insensitive. */
export function parseRegQueryValue(output: string, name: string): string | null {
  const line = output.split(/\r?\n/).find(
    (entry) => entry.trim().split(/\s+/)[0]?.toLowerCase() === name.toLowerCase(),
  );
  if (!line) return null;
  // Columns are name, type, value — the value itself may contain spaces.
  return line.trim().split(/\s+/).slice(2).join(' ') || null;
}

/**
 * Whether the registry values point at our System Proxy on `port`.
 *
 * `proxyEnable` is a REG_DWORD printed as 0x0/0x1. `proxyServer` is either a
 * bare `host:port` or a per-protocol list (`http=host:port;https=host:port`),
 * so each entry is compared whole — a substring match would let a proxy on
 * port 83781 pass as ours on 8378.
 */
export function isWindowsProxyPointingAt(
  proxyEnable: string | null,
  proxyServer: string | null,
  port: number,
): boolean {
  if (!proxyEnable || /^0x0+$/i.test(proxyEnable.trim())) return false;
  if (!proxyServer) return false;
  return proxyServer.split(';').some((entry) => {
    const endpoint = entry.trim().replace(/^[a-z]+=/i, '');
    return endpoint === `127.0.0.1:${port}` || endpoint === `localhost:${port}`;
  });
}
