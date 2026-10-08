import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAIN_POLL_MS, startVisiblePolling } from './chain-polling'

function fakeDoc(initial: DocumentVisibilityState = 'visible') {
  const listeners = new Set<() => void>()
  return {
    visibilityState: initial,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    set(state: DocumentVisibilityState) {
      this.visibilityState = state
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

describe('startVisiblePolling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never polls faster than 30 s', () => {
    const refresh = vi.fn()
    const doc = fakeDoc()
    const stop = startVisiblePolling(refresh, 5_000, doc as unknown as Document)
    vi.advanceTimersByTime(CHAIN_POLL_MS - 1)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10 * CHAIN_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(11)
    stop()
  })

  it('pauses while the tab is hidden and refreshes once on return', () => {
    const refresh = vi.fn()
    const doc = fakeDoc()
    const stop = startVisiblePolling(refresh, CHAIN_POLL_MS, doc as unknown as Document)
    doc.set('hidden')
    vi.advanceTimersByTime(10 * CHAIN_POLL_MS)
    expect(refresh).not.toHaveBeenCalled()
    doc.set('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CHAIN_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(10 * CHAIN_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(doc.listeners.size).toBe(0)
  })

  it('does not start polling in a tab opened in the background', () => {
    const refresh = vi.fn()
    const stop = startVisiblePolling(refresh, CHAIN_POLL_MS, fakeDoc('hidden') as unknown as Document)
    vi.advanceTimersByTime(5 * CHAIN_POLL_MS)
    expect(refresh).not.toHaveBeenCalled()
    stop()
  })
})
