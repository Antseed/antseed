import type { GatewayExposure } from '../api/types'
import { isOrgAdmin, type Viewer } from './nav'

const DISMISS_KEY = 'antseed-console-exposure-dismissed'

/** The banner shows only to org owners/admins, only off a public URL, and stays hidden for the session once dismissed. */
export function showExposureBanner(viewer: Viewer, exposure: GatewayExposure | null | undefined, dismissed: boolean): boolean {
  if (!exposure || exposure.mode === 'public' || dismissed) return false
  return isOrgAdmin(viewer)
}

/** Dismissal is per browser session and per mode, so a change (local → lan) shows it again. */
export function readDismissed(mode: string | undefined): boolean {
  if (!mode) return false
  try { return sessionStorage.getItem(DISMISS_KEY) === mode } catch { return false }
}

export function rememberDismissed(mode: string): void {
  try { sessionStorage.setItem(DISMISS_KEY, mode) } catch { /* storage unavailable */ }
}

export function exposureHeadline(exposure: GatewayExposure): string {
  return exposure.mode === 'local'
    ? 'This gateway runs on this computer'
    : 'This gateway is only reachable on your network'
}

export function exposureSummary(exposure: GatewayExposure): string {
  if (exposure.mode === 'local') return "Keys only work while it's on and can't be reached from other machines."
  return exposure.personalComputer
    ? 'Keys only work while this computer is on, over plain HTTP, and not from outside your network.'
    : 'It has no public HTTPS address: keys travel over plain HTTP and do not work from outside your network.'
}

const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A bare host name from what someone typed ("https://LLM.example.com/" → "llm.example.com"); null when it is not one. */
export function normalizeDomain(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '')
  return HOST_RE.test(host) ? host : null
}

export const BUNDLE_FILE = 'antseed-gateway.bundle'

export interface MigrationCommands {
  exportBundle: string
  copy: string
  install: string
  baseUrl: string
  stop: string
  recover: string
  tunnel: string
}

/** The commands the Migrate page shows; placeholders where the operator has not filled a value in. */
export function migrationCommands(input: { domain: string | null; server: string }): MigrationCommands {
  const domain = input.domain ?? 'llm.example.com'
  const server = input.server.trim() || 'user@your-server'
  const remote = `/tmp/${BUNDLE_FILE}`
  return {
    exportBundle: `antseed gateway export --out ${BUNDLE_FILE}`,
    copy: `scp ${BUNDLE_FILE} ${server}:${remote}`,
    install: `curl -fsSL https://antseed.com/install-gateway.sh | sudo bash -s -- --domain ${domain} --import ${remote}`,
    baseUrl: `https://${domain}/v1`,
    stop: `rm ${BUNDLE_FILE}`,
    recover: 'antseed gateway console-link --recover',
    tunnel: `CLOUDFLARED_TUNNEL_TOKEN=<tunnel-token> ANTSEED_TUNNEL_PUBLIC_URL=https://${domain} \\\n  antseed tunnel start --provider cloudflare`,
  }
}
