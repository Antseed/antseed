import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import type { GatewayExposure } from './console-api/types.js'

/** What the host looks like; read once at start-up, injectable for tests. */
export interface HostFacts {
  platform: NodeJS.Platform
  /** systemd is the init system (a typical Linux server). */
  systemd: boolean
  /** Inside a container (Docker, Podman, Kubernetes). */
  container: boolean
}

export function detectHostFacts(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): HostFacts {
  return {
    platform: process.platform,
    systemd: exists('/run/systemd/system') || Boolean(env['INVOCATION_ID']),
    container: exists('/.dockerenv') || exists('/run/.containerenv') || Boolean(env['KUBERNETES_SERVICE_HOST']),
  }
}

export type AddressScope = 'loopback' | 'any' | 'private' | 'public' | 'name'

function ipv4Scope(ip: string): AddressScope {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  if (a === 127) return 'loopback'
  if (a === 0) return 'any'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'private'
  // 100.64.0.0/10: carrier-grade NAT, and the range Tailscale hands out.
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  return 'public'
}

/** How far an address or hostname reaches: this machine, every interface, a private network, or the internet. */
export function addressScope(host: string | null | undefined): AddressScope {
  const value = (host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '' || value === '::' || value === '0.0.0.0' || value === '*') return 'any'
  if (value === 'localhost' || value.endsWith('.localhost')) return 'loopback'
  const family = isIP(value)
  if (family === 4) return ipv4Scope(value)
  if (family === 6) {
    if (value === '::1') return 'loopback'
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
    if (mapped) return ipv4Scope(mapped[1]!)
    if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value)) return 'private'
    return 'public'
  }
  // Single-label and local-only names never resolve on the internet.
  if (!value.includes('.') || /\.(local|lan|internal|home\.arpa|localdomain)$/.test(value)) return 'private'
  return 'name'
}

/** macOS or Windows, or a Linux box without systemd outside a container: probably someone's own computer. */
export function isPersonalComputer(host: HostFacts): boolean {
  if (host.platform === 'darwin' || host.platform === 'win32') return true
  return !host.systemd && !host.container
}

/**
 * Who can reach this gateway, judged only from its own configuration (no
 * outbound probes): `public` when it has a public URL (a domain or a
 * tunnel), `lan` when it listens beyond loopback without one, `local` when
 * only this machine can reach it.
 */
export function detectExposure(input: { publicUrl: string | null; listenHost: string | null; host: HostFacts }): GatewayExposure {
  const { listenHost, host } = input
  const reasons: string[] = []
  const personalComputer = isPersonalComputer(host)
  let publicUrl = input.publicUrl
  let mode: GatewayExposure['mode']
  let reachableFromInternet: boolean | null

  let urlScope: AddressScope | null = null
  if (publicUrl) {
    try {
      urlScope = addressScope(new URL(publicUrl).hostname)
    } catch {
      urlScope = null
    }
  }
  if (publicUrl && urlScope === 'loopback') {
    reasons.push(`The public URL ${publicUrl} points at this computer.`)
    publicUrl = null
  }

  if (publicUrl && urlScope === 'private') {
    mode = 'lan'
    reachableFromInternet = false
    reasons.push(`The console is served at ${publicUrl}, a private-network address.`)
  } else if (publicUrl) {
    mode = 'public'
    reachableFromInternet = true
    reasons.push(`The console is served at ${publicUrl}.`)
    if (publicUrl.startsWith('http://')) reasons.push('The public URL is plain HTTP: API keys cross the network unencrypted.')
  } else {
    const scope = addressScope(listenHost)
    if (scope === 'loopback') {
      mode = 'local'
      reachableFromInternet = false
      reasons.push(`The gateway listens on ${listenHost ?? '127.0.0.1'}, so only this computer can reach it.`)
    } else {
      mode = 'lan'
      if (scope === 'any') {
        reachableFromInternet = null
        reasons.push('The gateway listens on every network interface: other machines on your network can reach it over plain HTTP.')
      } else if (scope === 'public') {
        reachableFromInternet = true
        reasons.push(`The gateway listens on the public address ${listenHost} over plain HTTP: API keys cross the internet unencrypted.`)
      } else if (scope === 'private') {
        reachableFromInternet = false
        reasons.push(`The gateway listens on the private address ${listenHost}: only your network can reach it.`)
      } else {
        reachableFromInternet = null
        reasons.push(`The gateway listens on ${listenHost} over plain HTTP.`)
      }
      reasons.push('No public URL is set (--public-url, a domain or a tunnel).')
    }
  }

  if (personalComputer) {
    const where = host.platform === 'darwin' ? 'macOS' : host.platform === 'win32' ? 'Windows' : 'a machine without a service manager'
    reasons.push(`It runs on ${where}: keys work only while this computer is on, awake and online.`)
  }
  return { mode, publicUrl, listenHost: listenHost ?? null, reachableFromInternet, personalComputer, reasons }
}
