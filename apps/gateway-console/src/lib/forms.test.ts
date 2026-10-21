import { describe, expect, it, vi } from 'vitest'
import { submitOnly } from './forms'

describe('submitOnly', () => {
  it('runs the form\'s own action and stops the event before an enclosing form sees it', () => {
    const run = vi.fn()
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    submitOnly(run)(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })
})
