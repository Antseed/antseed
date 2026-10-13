import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayExposure } from '../api/types'
import { exposureHeadline, exposureSummary, migrationCommands, normalizeDomain, readDismissed, rememberDismissed, showExposureBanner } from './exposure'
import type { Viewer } from './nav'

const local: GatewayExposure = { mode: 'local', publicUrl: null, listenHost: '127.0.0.1', reachableFromInternet: false, personalComputer: true, reasons: [] }
const lan: GatewayExposure = { ...local, mode: 'lan', listenHost: '0.0.0.0', reachableFromInternet: null }
const pub: GatewayExposure = { ...local, mode: 'public', publicUrl: 'https://llm.example.com', reachableFromInternet: true, personalComputer: false }

const viewers: Record<string, Viewer> = {
  owner: { orgRole: 'owner', workspaceRole: 'admin' },
  admin: { orgRole: 'admin', workspaceRole: null },
  wsAdmin: { orgRole: 'member', workspaceRole: 'admin' },
  member: { orgRole: 'member', workspaceRole: 'member' },
}

describe('reachability banner', () => {
  it('shows to org owners and admins in local and lan mode only', () => {
    for (const exposure of [local, lan]) {
      expect(showExposureBanner(viewers.owner!, exposure, false)).toBe(true)
      expect(showExposureBanner(viewers.admin!, exposure, false)).toBe(true)
      expect(showExposureBanner(viewers.wsAdmin!, exposure, false)).toBe(false)
      expect(showExposureBanner(viewers.member!, exposure, false)).toBe(false)
    }
    for (const viewer of Object.values(viewers)) expect(showExposureBanner(viewer, pub, false)).toBe(false)
  })

  it('stays hidden once dismissed, and without a status yet', () => {
    expect(showExposureBanner(viewers.owner!, local, true)).toBe(false)
    expect(showExposureBanner(viewers.owner!, undefined, false)).toBe(false)
    expect(showExposureBanner(viewers.owner!, null, false)).toBe(false)
  })

  it('reads the user story copy for a laptop gateway', () => {
    expect(`${exposureHeadline(local)}. ${exposureSummary(local)}`).toBe("This gateway runs on this computer. Keys only work while it's on and can't be reached from other machines.")
    expect(exposureHeadline(lan)).toMatch(/your network/)
    expect(exposureSummary({ ...lan, personalComputer: false })).toMatch(/plain HTTP/)
  })
})

describe('dismissal per session and mode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('remembers the dismissed mode in sessionStorage', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
    expect(readDismissed('local')).toBe(false)
    rememberDismissed('local')
    expect(readDismissed('local')).toBe(true)
    expect(readDismissed('lan')).toBe(false)
    expect(readDismissed(undefined)).toBe(false)
  })

  it('treats unavailable storage as not dismissed', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(() => rememberDismissed('local')).not.toThrow()
    expect(readDismissed('local')).toBe(false)
  })
})

describe('migration commands', () => {
  it('normalizes a typed domain', () => {
    expect(normalizeDomain(' https://LLM.Example.com/console ')).toBe('llm.example.com')
    expect(normalizeDomain('llm.example.com:443')).toBe('llm.example.com')
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain('not a domain')).toBeNull()
    expect(normalizeDomain('')).toBeNull()
  })

  it('fills the domain and server into the commands, with placeholders otherwise', () => {
    const placeholder = migrationCommands({ domain: null, server: '' })
    expect(placeholder.exportBundle).toBe('antseed gateway export --out antseed-gateway.bundle')
    expect(placeholder.copy).toBe('scp antseed-gateway.bundle user@your-server:/tmp/antseed-gateway.bundle')
    expect(placeholder.install).toBe('curl -fsSL https://antseed.com/install-gateway.sh | sudo bash -s -- --domain llm.example.com --import /tmp/antseed-gateway.bundle')

    const filled = migrationCommands({ domain: 'ai.acme.test', server: 'ops@203.0.113.7' })
    expect(filled.copy).toContain('ops@203.0.113.7:/tmp/antseed-gateway.bundle')
    expect(filled.install).toContain('--domain ai.acme.test --import /tmp/antseed-gateway.bundle')
    expect(filled.baseUrl).toBe('https://ai.acme.test/v1')
    expect(filled.tunnel).toContain('ANTSEED_TUNNEL_PUBLIC_URL=https://ai.acme.test')
    expect(filled.recover).toBe('antseed gateway console-link --recover')
  })
})
