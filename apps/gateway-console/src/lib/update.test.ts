import { describe, expect, it } from 'vitest'
import type { GatewayUpdate } from '../api/types'
import type { Viewer } from './nav'
import { showUpdateNotice, UPDATE_PICKUP_MS, updateInFlight, updatePhase } from './update'

const base: GatewayUpdate = {
  current: '0.1.180', latest: '0.1.193', available: true, checkedAt: 1, checkError: null, checksDisabled: false,
  apply: 'console', install: 'installer', command: 'antseed update', note: '', progress: null,
}
const owner: Viewer = { orgRole: 'owner', workspaceRole: 'admin' }
const member: Viewer = { orgRole: 'member', workspaceRole: 'member' }
const progress = (state: 'requested' | 'running' | 'succeeded' | 'failed', startedAt = 1_000) =>
  ({ state, from: null, to: null, startedAt, finishedAt: null, error: state === 'failed' ? 'npm install exited with 1' : null })

describe('updatePhase', () => {
  it('follows the update service from request to result', () => {
    expect(updatePhase(base)).toBe('available')
    expect(updatePhase({ ...base, available: false })).toBe('current')
    expect(updatePhase({ ...base, progress: progress('requested') }, 2_000)).toBe('requested')
    expect(updatePhase({ ...base, progress: progress('requested') }, 1_000 + UPDATE_PICKUP_MS + 1)).toBe('stalled')
    expect(updatePhase({ ...base, progress: progress('running') })).toBe('running')
    expect(updatePhase({ ...base, progress: progress('failed') })).toBe('failed')
    expect(updatePhase({ ...base, available: false, progress: progress('failed') })).toBe('current')
    expect(updatePhase({ ...base, available: false, progress: progress('succeeded') })).toBe('current')
  })
})

describe('showUpdateNotice', () => {
  it('shows owners and admins a newer version until they dismiss that version', () => {
    expect(showUpdateNotice(owner, base, null)).toBe(true)
    expect(showUpdateNotice(member, base, null)).toBe(false)
    expect(showUpdateNotice(owner, base, '0.1.193')).toBe(false)
    expect(showUpdateNotice(owner, base, '0.1.190')).toBe(true)
    expect(showUpdateNotice(owner, { ...base, available: false }, null)).toBe(false)
    expect(showUpdateNotice(owner, { ...base, apply: 'none' }, null)).toBe(false)
    expect(showUpdateNotice(owner, undefined, null)).toBe(false)
  })

  it('keeps showing a running update even when dismissed', () => {
    const running = { ...base, progress: progress('running') }
    expect(updateInFlight(running)).toBe(true)
    expect(showUpdateNotice(owner, running, '0.1.193')).toBe(true)
  })
})
