import { describe, expect, it } from 'vitest'
import type { GatewayUpdate } from '../api/types'
import type { Viewer } from './nav'
import { noticeVersion, readyVersion, showUpdateNotice, UPDATE_PICKUP_MS, updateInFlight, updatePhase, updateRestarting } from './update'

const base: GatewayUpdate = {
  product: 'cli', current: '0.1.180', latest: '0.1.193', available: true, checkedAt: 1, checkError: null, checksDisabled: false,
  apply: 'console', install: 'installer', command: 'antseed update', note: '', progress: null, downloaded: null,
}
const owner: Viewer = { orgRole: 'owner', workspaceRole: 'admin' }
const member: Viewer = { orgRole: 'member', workspaceRole: 'member' }
const progress = (state: 'requested' | 'running' | 'ready' | 'succeeded' | 'failed', startedAt = 1_000, action: 'download' | 'install' = 'install') =>
  ({ state, action, from: null, to: state === 'ready' ? '0.1.193' : null, startedAt, finishedAt: null, error: state === 'failed' ? 'npm install exited with 1' : null })

describe('updatePhase', () => {
  it('follows the update service from request to result', () => {
    expect(updatePhase(base)).toBe('available')
    expect(updatePhase({ ...base, available: false })).toBe('current')
    expect(updatePhase({ ...base, progress: progress('requested') }, 2_000)).toBe('requested')
    expect(updatePhase({ ...base, progress: progress('requested') }, 1_000 + UPDATE_PICKUP_MS + 1)).toBe('stalled')
    expect(updatePhase({ ...base, progress: progress('running') })).toBe('installing')
    expect(updatePhase({ ...base, progress: progress('failed') })).toBe('failed')
    expect(updatePhase({ ...base, available: false, progress: progress('failed') })).toBe('current')
    expect(updatePhase({ ...base, available: false, progress: progress('succeeded') })).toBe('current')
  })

  it('downloads first and installs on Restart & update, like the desktop app', () => {
    const downloading = { ...base, progress: progress('running', 1_000, 'download') }
    expect(updatePhase(downloading)).toBe('downloading')
    expect(updateInFlight(downloading)).toBe(true)
    expect(updateRestarting(downloading)).toBe(false)
    const ready = { ...base, progress: progress('ready', 1_000, 'download'), downloaded: '0.1.193' }
    expect(updatePhase(ready)).toBe('ready')
    expect(readyVersion(ready)).toBe('0.1.193')
    expect(updateInFlight(ready)).toBe(false)
    expect(updateRestarting({ ...base, progress: progress('running') })).toBe(true)
    // npm moving on keeps the downloaded version installable; one already running is not ready.
    const overtaken = { ...ready, latest: '0.1.194' }
    expect(updatePhase(overtaken)).toBe('ready')
    expect(readyVersion(overtaken)).toBe('0.1.193')
    expect(noticeVersion(overtaken)).toBe('0.1.193')
    expect(updatePhase({ ...ready, current: '0.1.193', available: false, downloaded: null })).toBe('current')
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

  it('shows a downloaded version until it is dismissed', () => {
    const ready = { ...base, progress: progress('ready', 1_000, 'download'), downloaded: '0.1.193' }
    expect(showUpdateNotice(owner, ready, null)).toBe(true)
    expect(showUpdateNotice(owner, ready, '0.1.193')).toBe(false)
  })

  it('keeps showing a running update even when dismissed', () => {
    const running = { ...base, progress: progress('running') }
    expect(updateInFlight(running)).toBe(true)
    expect(showUpdateNotice(owner, running, '0.1.193')).toBe(true)
  })
})
