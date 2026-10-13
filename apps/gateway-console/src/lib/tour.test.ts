import { describe, expect, it, vi } from 'vitest'

vi.mock('driver.js', () => ({ driver: vi.fn() }))
vi.mock('driver.js/dist/driver.css', () => ({}))

const { tourSteps } = await import('./tour')

describe('first-run tour', () => {
  it('shows an org admin every part, buyer settings before routing', () => {
    const targets = tourSteps({ orgRole: 'owner', workspaceRole: 'admin' }).map((step) => step.target ?? 'welcome')
    expect(targets).toEqual(['welcome', 'workspace', 'nav-wallet', 'nav-keys', 'nav-settings', 'nav-routing', 'nav-providers', 'nav-activity', 'nav-chat', 'account'])
  })

  it('shows a member only the pages they can open', () => {
    const targets = tourSteps({ orgRole: 'member', workspaceRole: 'member' }).map((step) => step.target ?? 'welcome')
    expect(targets).toEqual(['welcome', 'workspace', 'nav-keys', 'nav-providers', 'nav-activity', 'nav-chat', 'account'])
  })
})
