import { describe, expect, it, vi } from 'vitest'
import { ConsoleApiError, createApiClient } from '../api/client'
import type { Invite, Member } from '../api/types'
import { budgetWarnings, runway } from './budget'
import { fromDateInput, toDateInput } from './dates'
import { HEARTBEAT_MS, startDepositHeartbeat } from './deposit-watch'
import { duplicateInviteWarnings } from './members'
import { assertSameMember, reauthWithWallet, withReauth } from './reauth'
import { buyerSettingsErrors } from './settings'

describe('budget warnings and runway', () => {
  const limits = { daily: '10.000000', weekly: '100.000000', monthly: null, total: null }
  it('warns from 80% and marks reached budgets', () => {
    const warnings = budgetWarnings(limits, [['daily', 8], ['weekly', 120], ['monthly', 999]])
    expect(warnings.map((w) => [w.period, w.reached])).toEqual([['daily', false], ['weekly', true]])
    expect(budgetWarnings(limits, [['daily', 7.9]])).toEqual([])
  })
  it('estimates runway from the last week', () => {
    expect(runway(70, 70, 7)).toMatchObject({ dailySpend: 10, days: 7, low: false })
    expect(runway(20, 70, 7)).toMatchObject({ days: 2, low: true })
    expect(runway(0.5, 0, 7)).toMatchObject({ days: null, low: true })
    expect(runway(50, 0, 7)).toMatchObject({ days: null, low: false })
  })
})

describe('buyer settings validation', () => {
  it('rejects blanks instead of saving 0', () => {
    expect(buyerSettingsErrors({ input: '', output: '5', cached: '', reputation: '' })).toEqual({ input: 'Required.', reputation: 'Required.' })
    expect(buyerSettingsErrors({ input: '1', output: '-1', cached: 'x', reputation: '101' })).toEqual({
      output: 'Use a number of 0 or more.', cached: 'Use a number of 0 or more.', reputation: 'At most 100.',
    })
    expect(buyerSettingsErrors({ input: '1', output: '2', cached: '', reputation: '0' })).toEqual({})
  })
})

describe('invite duplicates', () => {
  const members = [{ id: 'm1', label: 'Sam', email: 'sam@example.com', status: 'active' } as Member]
  const invites = [{ id: 'i1', label: 'Robin', email: 'robin@example.com', expiresAt: Date.now() + 1000 } as Invite]
  it('warns on a matching email or name', () => {
    expect(duplicateInviteWarnings({ label: 'Other', email: 'SAM@example.com' }, members, invites)).toEqual(['Sam already uses sam@example.com.'])
    expect(duplicateInviteWarnings({ label: 'robin', email: '' }, members, invites)).toEqual(['A pending invite for Robin already exists.'])
    expect(duplicateInviteWarnings({ label: 'New', email: '' }, members, invites)).toEqual([])
  })
})

describe('date inputs', () => {
  it('maps to UTC day bounds', () => {
    expect(fromDateInput('2026-10-01', 'start')).toBe(Date.UTC(2026, 9, 1))
    expect(fromDateInput('2026-10-01', 'end')).toBe(Date.UTC(2026, 9, 1, 23, 59, 59, 999))
    expect(fromDateInput('', 'start')).toBeUndefined()
    expect(toDateInput(Date.UTC(2026, 9, 1, 12))).toBe('2026-10-01')
  })
})

describe('re-authentication', () => {
  it('retries once after a fresh sign-in on reauth_required', async () => {
    const action = vi.fn()
      .mockRejectedValueOnce(new ConsoleApiError(403, 'reauth_required', 'Sign in again'))
      .mockResolvedValueOnce('ok')
    const reauth = vi.fn(async () => {})
    await expect(withReauth(action, reauth)).resolves.toBe('ok')
    expect(reauth).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledTimes(2)
  })
  it('passes other errors through', async () => {
    const reauth = vi.fn(async () => {})
    await expect(withReauth(() => Promise.reject(new ConsoleApiError(403, 'forbidden', 'No')), reauth)).rejects.toMatchObject({ code: 'forbidden' })
    expect(reauth).not.toHaveBeenCalled()
  })
  it('confirms with the wallet through the re-auth endpoints, not the sign-in ones', async () => {
    const me = { kind: 'member', me: { member: { id: 'mine' }, workspaces: [] } }
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/nonce') ? { message: 'sign me' } : me), { status: 200, headers: { 'content-type': 'application/json' } }))
    const sign = vi.fn(async (message: string) => `sig:${message}`)
    await expect(reauthWithWallet('0xabc', sign, createApiClient(fetch))).resolves.toEqual(me)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/console/api/auth/reauth/wallet/nonce', '/console/api/auth/reauth/wallet/verify'])
    expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ message: 'sign me', signature: 'sig:sign me' })
  })
  it('refuses a sign-in that switched accounts', () => {
    const me = { kind: 'member' as const, me: { member: { id: 'other' } as Member, workspaces: [] } }
    expect(() => assertSameMember(me, 'mine')).toThrow('different account')
    expect(() => assertSameMember({ ...me, me: { ...me.me, member: { id: 'mine' } as Member } }, 'mine')).not.toThrow()
  })
})

describe('deposit watch heartbeat', () => {
  function fakeDoc(state: 'visible' | 'hidden') {
    const listeners = new Set<() => void>()
    return {
      visibilityState: state as DocumentVisibilityState,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      fire() { listeners.forEach((fn) => fn()) },
    }
  }
  it('sends active every minute while visible and background when hidden or stopped', async () => {
    vi.useFakeTimers()
    const watch = vi.fn(async () => ({ mode: 'active' as const, status: 'watching', lastTxHash: null }))
    const doc = fakeDoc('visible')
    const stop = startDepositHeartbeat('ws_1', { wallet: { watch } } as never, doc as never)
    expect(watch).toHaveBeenLastCalledWith('ws_1', 'active')
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    expect(watch).toHaveBeenCalledTimes(3)
    doc.visibilityState = 'hidden'
    doc.fire()
    expect(watch).toHaveBeenLastCalledWith('ws_1', 'background')
    vi.advanceTimersByTime(HEARTBEAT_MS * 3)
    expect(watch).toHaveBeenCalledTimes(4)
    doc.visibilityState = 'visible'
    doc.fire()
    expect(watch).toHaveBeenLastCalledWith('ws_1', 'active')
    stop()
    expect(watch).toHaveBeenLastCalledWith('ws_1', 'background')
    vi.useRealTimers()
  })
  it('does not start while the page is hidden', () => {
    const watch = vi.fn(async () => ({}))
    const stop = startDepositHeartbeat('ws_1', { wallet: { watch } } as never, fakeDoc('hidden') as never)
    stop()
    expect(watch).not.toHaveBeenCalled()
  })
})
