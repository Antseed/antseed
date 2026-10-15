import { describe, expect, it } from 'vitest'
import type { MeResponse, Member } from '../api/types'
import { canOpen, movedPagePath, panelPath, panelSelection, visibleNav, viewerFor } from './nav'

const ids = (orgRole: 'owner' | 'admin' | 'member', workspaceRole: 'admin' | 'member' | null) => visibleNav({ orgRole, workspaceRole }).map((item) => item.id)

describe('role-based navigation', () => {
  it('shows everything to owners and org admins', () => {
    const all = ['overview', 'chat', 'activity', 'logs', 'keys', 'presets', 'wallet', 'rewards', 'referrals', 'providers', 'models', 'routing', 'members', 'workspaces', 'builders', 'audit', 'settings']
    expect(ids('owner', null)).toEqual(all)
    expect(ids('admin', 'member')).toEqual(all)
  })
  it('gives workspace admins workspace management but not settings', () => {
    const nav = ids('member', 'admin')
    expect(nav).toContain('members')
    expect(nav).toContain('wallet')
    expect(nav).toContain('routing')
    expect(nav).toContain('referrals')
    expect(nav).not.toContain('settings')
    expect(nav).not.toContain('builders')
  })
  it('limits plain members to their own usage, keys, presets, providers and models', () => {
    expect(ids('member', 'member')).toEqual(['overview', 'chat', 'activity', 'logs', 'keys', 'presets', 'providers', 'models'])
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

describe('side panel routes', () => {
  it('encodes the open id as one path segment', () => {
    expect(panelPath('models', 'qwen/qwen3-coder')).toBe('models/qwen%2Fqwen3-coder')
    expect(panelPath('providers', '0xFA1E01')).toBe('providers/0xFA1E01')
    expect(panelPath('models', null)).toBe('models')
    expect(panelPath('providers', '')).toBe('providers')
  })
  it('reads the open id back from the decoded path, tolerating an unencoded slash', () => {
    expect(panelSelection([])).toBeNull()
    expect(panelSelection(['qwen/qwen3-coder'])).toBe('qwen/qwen3-coder')
    expect(panelSelection(['qwen', 'qwen3-coder'])).toBe('qwen/qwen3-coder')
  })
  it('redirects the old Network page and seller pages to Providers', () => {
    expect(movedPagePath('network', [])).toBe('providers')
    expect(movedPagePath('network', ['0xFA1E01'])).toBe('providers/0xFA1E01')
    expect(movedPagePath('providers', ['0xFA1E01'])).toBeNull()
    expect(movedPagePath('models', [])).toBeNull()
  })
})
