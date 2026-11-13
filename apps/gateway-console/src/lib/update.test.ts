import { describe, expect, it } from 'vitest'
import type { GatewayUpdate } from '../api/types'
import type { Viewer } from './nav'
import {
  formatBound, INSTALL_STEPS, noticeVersion, readyVersion, recentUpdateResult, showUpdateNotice, UPDATE_PICKUP_MS, UPDATE_RECONNECT_AFTER_MS,
  UPDATE_RESULT_NOTICE_MS, updateInFlight, updatePhase, updateProgressView, updateReconnecting, updateRestarting, updateTook,
} from './update'

type RunPhase = NonNullable<NonNullable<GatewayUpdate['progress']>['phase']>

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

  it('reports a finished Restart & update for a while, until dismissed', () => {
    const finishedAt = 1_000_000
    const succeeded: GatewayUpdate = {
      ...base, current: '0.1.193', latest: '0.1.193', available: false,
      progress: { state: 'succeeded', action: 'install', from: '0.1.180', to: '0.1.193', startedAt: finishedAt - 151_000, finishedAt, error: null },
    }
    expect(recentUpdateResult(succeeded, finishedAt + 60_000)).toBe('succeeded')
    expect(updateTook(succeeded)).toBe(151_000)
    expect(showUpdateNotice(owner, succeeded, null, finishedAt + 60_000)).toBe(true)
    expect(noticeVersion(succeeded, finishedAt + 60_000)).toBe('0.1.193')
    expect(showUpdateNotice(owner, succeeded, '0.1.193', finishedAt + 60_000)).toBe(false)
    expect(recentUpdateResult(succeeded, finishedAt + UPDATE_RESULT_NOTICE_MS + 1)).toBeNull()
    expect(showUpdateNotice(owner, succeeded, null, finishedAt + UPDATE_RESULT_NOTICE_MS + 1)).toBe(false)
    // Already on the latest: nothing was installed, nothing to report.
    expect(recentUpdateResult({ ...succeeded, progress: { ...succeeded.progress!, from: '0.1.193' } }, finishedAt)).toBeNull()
    // Downloads are not reported; failures are.
    expect(recentUpdateResult({ ...succeeded, progress: { ...succeeded.progress!, action: 'download', state: 'ready' } }, finishedAt)).toBeNull()
    expect(recentUpdateResult({ ...base, progress: { ...progress('failed'), finishedAt } }, finishedAt)).toBe('failed')
  })
})

describe('updateProgressView', () => {
  const running = (phase?: RunPhase, extra: Partial<NonNullable<GatewayUpdate['progress']>> = {}): GatewayUpdate => ({
    ...base,
    progress: { state: 'running', action: 'install', from: '0.1.180', to: '0.1.193', startedAt: 10_000, finishedAt: null, error: null, ...(phase ? { phase, phaseStartedAt: 70_000 } : {}), ...extra },
  })

  it('names each step of Restart & update, with its place and bound', () => {
    expect(INSTALL_STEPS).toEqual(['downloading', 'restarting-buyer', 'draining-gateway', 'starting-gateway', 'checking'])
    const draining = updateProgressView(running('draining-gateway', { phaseMaxMs: 90_000 }))!
    expect(draining).toMatchObject({ title: 'Waiting for in-flight requests to finish', step: 3, steps: 5, startedAt: 10_000, stepStartedAt: 70_000, stepMaxMs: 90_000, reconnecting: false })
    expect(draining.detail).toContain('This can take up to 90s.')
    expect(updateProgressView(running('downloading'))).toMatchObject({ title: 'Downloading 0.1.193', step: 1 })
    expect(updateProgressView(running('restarting-buyer'))).toMatchObject({ title: 'Restarting the buyer', step: 2, stepMaxMs: null })
    expect(updateProgressView(running('starting-gateway'))).toMatchObject({ step: 4 })
    expect(updateProgressView(running('checking'))!.detail).toContain('goes back to 0.1.180')
    // Rolling back is off the usual path: no step count.
    expect(updateProgressView(running('rolling-back'))).toMatchObject({ title: 'Going back to 0.1.180', step: null })
  })

  it('shows a download as one step, a request as waiting, and nothing once done', () => {
    const download = running('downloading', { action: 'download' })
    expect(updateProgressView(download)).toMatchObject({ title: 'Downloading 0.1.193', step: null })
    expect(updateProgressView(download)!.detail).toContain('until you restart it')
    expect(updateProgressView({ ...base, progress: progress('requested') })).toMatchObject({ title: 'Waiting for the update service', step: null, startedAt: 1_000 })
    expect(updateProgressView({ ...base, progress: progress('succeeded') })).toBeNull()
    expect(updateProgressView(base)).toBeNull()
    expect(updateProgressView(undefined)).toBeNull()
  })

  it('still shows a timer for updaters that report no steps', () => {
    expect(updateProgressView(running())).toMatchObject({ title: 'Updating to 0.1.193', step: null, startedAt: 10_000 })
    const desktop = updateProgressView({ ...running('checking'), product: 'desktop' })!
    expect(desktop.step).toBeNull()
    expect(desktop.detail).toContain('desktop app restarts')
  })

  it('says the gateway is restarting while it cannot be reached, keeping the step', () => {
    const view = updateProgressView(running('draining-gateway', { phaseMaxMs: 90_000 }), { reconnecting: true })!
    expect(view).toMatchObject({ title: 'The gateway is restarting', step: 3, reconnecting: true })
    expect(view.detail).toMatch(/^This page reconnects by itself once it is back\. .*up to 90s\.$/)
    expect(updateProgressView(running('starting-gateway'), { reconnecting: true })!.detail).toBe('This page reconnects by itself once it is back.')
    // A download never restarts anything.
    expect(updateProgressView(running('downloading', { action: 'download' }), { reconnecting: true })!.reconnecting).toBe(false)
  })
})

describe('updateReconnecting', () => {
  const installing: GatewayUpdate = { ...base, progress: progress('running') }
  it('reads a failed or overdue poll during a restarting update as the gateway restarting', () => {
    expect(updateReconnecting(installing, { error: null, dataUpdatedAt: 10_000 }, 12_000)).toBe(false)
    expect(updateReconnecting(installing, { error: new Error('Could not reach the gateway.'), dataUpdatedAt: 10_000 }, 12_000)).toBe(true)
    // A proxy holding the request until the new gateway is up: no answer for a while.
    expect(updateReconnecting(installing, { error: null, dataUpdatedAt: 10_000 }, 10_000 + UPDATE_RECONNECT_AFTER_MS + 1)).toBe(true)
  })
  it('leaves other errors alone', () => {
    const error = new Error('boom')
    expect(updateReconnecting(base, { error, dataUpdatedAt: 0 }, 1)).toBe(false)
    expect(updateReconnecting({ ...base, progress: progress('running', 1_000, 'download') }, { error, dataUpdatedAt: 0 }, 1)).toBe(false)
    expect(updateReconnecting(undefined, { error, dataUpdatedAt: 0 }, 1)).toBe(false)
  })
})

describe('formatBound', () => {
  it('says short bounds in seconds and long ones in minutes', () => {
    expect(formatBound(90_000)).toBe('90s')
    expect(formatBound(120_000)).toBe('2 min')
    expect(formatBound(900_000)).toBe('15 min')
  })
})
