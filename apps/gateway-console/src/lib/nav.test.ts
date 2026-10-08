import { describe, expect, it } from 'vitest'
import type { MeResponse, Member } from '../api/types'
import { canOpen, visibleNav, viewerFor } from './nav'

const ids = (orgRole: 'owner' | 'admin' | 'member', workspaceRole: 'admin' | 'member' | null) => visibleNav({ orgRole, workspaceRole }).map((item) => item.id)

describe('role-based navigation', () => {
  it('shows everything to owners and org admins', () => {
    const all = ['overview', 'activity', 'logs', 'keys', 'presets', 'wallet', 'rewards', 'network', 'routing', 'members', 'workspaces', 'audit', 'settings']
    expect(ids('owner', null)).toEqual(all)
    expect(ids('admin', 'member')).toEqual(all)
  })
  it('gives workspace admins workspace management but not settings', () => {
    const nav = ids('member', 'admin')
    expect(nav).toContain('members')
    expect(nav).toContain('wallet')
    expect(nav).toContain('routing')
    expect(nav).not.toContain('settings')
  })
  it('limits plain members to their own usage, keys, presets and the network', () => {
    expect(ids('member', 'member')).toEqual(['overview', 'activity', 'logs', 'keys', 'presets', 'network'])
  })
  it('blocks direct navigation to hidden pages', () => {
    expect(canOpen('settings', { orgRole: 'member', workspaceRole: 'admin' })).toBe(false)
    expect(canOpen('wallet', { orgRole: 'member', workspaceRole: 'member' })).toBe(false)
  })

  it('derives the viewer from /auth/me', () => {
    const member = { id: 'm', orgRole: 'member' } as Member
    const me: MeResponse = { kind: 'member', me: { member, workspaces: [{ workspace: { id: 'w1', name: 'A', isDefault: true }, role: 'admin' }] } }
    expect(viewerFor(me, 'w1')).toEqual({ orgRole: 'member', workspaceRole: 'admin' })
    expect(viewerFor(me, 'other')).toEqual({ orgRole: 'member', workspaceRole: null })
    expect(viewerFor({ kind: 'key', me: { key: {} as never } }, 'w1')).toBeNull()
  })
})
