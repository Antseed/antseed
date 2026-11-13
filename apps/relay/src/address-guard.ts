/**
 * Guards the bridge against dialing internal networks. Seller endpoints
 * discovered over the DHT are attacker-controlled (any peer can announce any
 * publicAddress), so before dialing one the relay rejects loopback, private,
 * link-local, and CGNAT ranges — both for IP literals and for what a hostname
 * actually resolves to (covers DNS rebinding). Operator-configured static
 * sellers skip the guard so local/e2e setups keep working.
 */

import { lookup, type LookupAddress } from 'node:dns';
import net from 'node:net';

export function isForbiddenIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isForbiddenV4(ip);
  if (family === 6) return isForbiddenV6(ip);
  return true;
}

function isForbiddenV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||                        // "this network"
    a === 10 ||                       // private
    a === 127 ||                      // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||       // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168)          // private
  );
}

function isForbiddenV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified / loopback

  for (const embedded of embeddedV4s(lower)) {
    if (isForbiddenV4(embedded)) return true;
  }

  const firstHextet = lower.split(':', 1)[0] ?? '';
  if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(firstHextet)) return true; // link-local fe80::/10
  return false;
}

/** Extracts candidate IPv4 addresses embedded in an IPv6 string. */
function embeddedV4s(lower: string): string[] {
  const out: string[] = [];
  const groups = lower.split(':');

  const tail = groups[groups.length - 1];
  if (tail && tail.includes('.') && net.isIP(tail) === 4) out.push(tail);

  const h = expandHextets(lower);
  if (h) {
    // mapped ::ffff:x:x / compat ::x:x
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 &&
        (h[5] === 0 || h[5] === 0xffff)) {
      out.push(hextetsToV4(h[6]!, h[7]!));
    }
    // 6to4 2002::/16
    if (h[0] === 0x2002) out.push(hextetsToV4(h[1]!, h[2]!));
    // Teredo 2001:0::/32 — client v4 is the trailing hextets XOR 0xffff
    if (h[0] === 0x2001 && h[1] === 0x0000) {
      out.push(hextetsToV4(h[6]! ^ 0xffff, h[7]! ^ 0xffff));
    }
  }
  return out;
}

/** Expands an IPv6 string (incl. `::` and dotted tail) to eight 16-bit words. */
function expandHextets(lower: string): number[] | null {
  let str = lower;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (dotted && net.isIP(dotted[1]!) === 4) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number];
    str = str.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const nums = words.map((w) => parseInt(w || '0', 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

function hextetsToV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * dns.lookup wrapper for net.connect that fails when an untrusted hostname
 * resolves into a forbidden range. Handles both single-address and all:true
 * lookups (Node's autoSelectFamily uses the latter). net.connect skips lookup
 * for IP literals, so callers must check those with isForbiddenIp() separately.
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  lookup(hostname, options, (err, address, family) => {
    if (!err) {
      const resolved = Array.isArray(address)
        ? (address as LookupAddress[]).map((a) => a.address)
        : [address];
      const forbidden = resolved.find((a) => isForbiddenIp(a));
      if (forbidden !== undefined) {
        callback(new Error(`refusing to dial forbidden address ${forbidden} (${hostname})`), address, family);
        return;
      }
    }
    callback(err, address, family);
  });
};
