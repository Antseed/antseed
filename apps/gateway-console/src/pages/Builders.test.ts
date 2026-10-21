import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Builders as BuildersView } from '../api/types'

// There is no DOM here, so state is kept across server renders: hooks take slots
// in call order (the mocked tree below calls useState only in Builders and its
// agent dialog), and slots a render no longer reaches are dropped, as on unmount.
const ui = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  data: undefined as BuildersView | undefined,
  buttons: new Map<string, () => void>(),
  modals: new Map<string, { isOpen: boolean; onClose: () => void }>(),
  change: undefined as ((event: { target: { value: string } }) => void) | undefined,
  builderClaimable: undefined as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState: <S>(initial: S | (() => S)) => {
      const slot = ui.cursor++
      if (slot >= ui.slots.length) ui.slots[slot] = typeof initial === 'function' ? (initial as () => S)() : initial
      const set = (next: S | ((prev: S) => S)) => {
        ui.slots[slot] = typeof next === 'function' ? (next as (prev: S) => S)(ui.slots[slot] as S) : next
      }
      return [ui.slots[slot] as S, set] as const
    },
  }
})

const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : ''

vi.mock('@antseed/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  LoadingRows: () => null,
  useToast: () => () => {},
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    if (onClick) ui.buttons.set(text(children), onClick)
    return createElement('button', { disabled }, children)
  },
  // Renders its content even while closed, so a mounted-but-hidden dialog shows up.
  Modal: ({ isOpen, onClose, title, children }: { isOpen: boolean; onClose: () => void; title: string; children: ReactNode }) => {
    ui.modals.set(title, { isOpen, onClose })
    return createElement('section', { 'aria-label': title, 'data-open': String(isOpen) }, children)
  },
  TextField: ({ label, value, onChange }: { label: string; value: string; onChange: (event: { target: { value: string } }) => void }) => {
    ui.change = onChange
    return createElement('input', { 'aria-label': label, value, onChange })
  },
}))

vi.mock('../components/ui', () => {
  const box = ({ children, actions }: { children?: ReactNode; actions?: ReactNode }) => createElement('div', null, actions, children)
  return {
    Badge: box, DetailList: () => null, ErrorAlert: () => null, Mono: box, PageHeader: () => null, Panel: box, StatTile: () => null,
    QueryView: ({ query, children }: { query: { data: BuildersView | undefined }; children: (data: BuildersView) => ReactNode }) =>
      query.data === undefined ? null : createElement('div', null, children(query.data)),
  }
})
vi.mock('../components/ChainGate', () => ({ ChainGate: () => null }))
vi.mock('../wallet/ReferralClaim', () => ({ default: () => null }))
vi.mock('../api', () => {
  ui.builderClaimable = vi.fn()
  return { api: { referrals: { builders: vi.fn(), setBuilderAgent: vi.fn(), builderClaimable: ui.builderClaimable } } }
})
vi.mock('../lib/queries', () => ({ qk: { builders: ['builders'] }, useChain: () => ({ data: undefined, error: null }) }))
// A write that resolves at once: mutate runs the request and its onSuccess in the same call.
vi.mock('../lib/mutations', () => ({
  useConsoleMutation: (options: { mutationFn: (variables: unknown) => unknown; onSuccess?: (data: unknown, variables: unknown) => void }) => ({
    mutate: (variables?: unknown) => options.onSuccess?.(options.mutationFn(variables), variables),
    isPending: false,
    error: null,
  }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useQuery: () => ({ data: ui.data, error: null, isLoading: false, refetch: () => {} }),
}))

const { default: Builders } = await import('./Builders')

const view = (agentId: number | null): BuildersView => ({
  available: false,
  indexed: false,
  agentId,
  effective: { agentId, source: agentId !== null ? 'config' : 'default', client: 'cli', runtime: true },
  agent: null,
})

function render() {
  ui.cursor = 0
  ui.buttons.clear()
  ui.modals.clear()
  ui.change = undefined
  const html = renderToStaticMarkup(createElement(Builders))
  ui.slots.length = ui.cursor
  return html
}

const agentField = (html: string) => html.match(/<input aria-label="Agent id" value="([^"]*)"/)?.[1]
const click = (label: string) => {
  const onClick = ui.buttons.get(label)
  if (!onClick) throw new Error(`no "${label}" button`)
  onClick()
}

beforeEach(() => {
  ui.slots = []
  ui.data = view(42)
})

describe('Builders agent dialog', () => {
  it('is not mounted until the editor opens', () => {
    const html = render()
    expect(ui.modals.has('Client agent')).toBe(false)
    expect(agentField(html)).toBeUndefined()
  })

  it('drops a cancelled draft, so reopening shows the saved agent', () => {
    render()
    click('Change')
    expect(agentField(render())).toBe('42')

    ui.change?.({ target: { value: '99' } })
    expect(agentField(render())).toBe('99')

    click('Cancel')
    expect(agentField(render())).toBeUndefined()

    click('Change')
    expect(agentField(render())).toBe('42')
  })

  it('reopens on the agent saved since it was last open', () => {
    render()
    click('Change')
    expect(agentField(render())).toBe('42')
    ui.modals.get('Client agent')?.onClose()
    render()

    ui.data = view(7)
    render()
    click('Change')
    expect(agentField(render())).toBe('7')
  })

  it('opens empty when no agent is set', () => {
    ui.data = view(null)
    render()
    click('Set agent')
    expect(agentField(render())).toBe('')
  })
})

describe('Builders client agent source', () => {
  it('labels an agent the buyer did not report as an estimate, in one line', () => {
    ui.data = { ...view(42), effective: { agentId: 42, source: 'config', client: 'cli', runtime: false } }
    const html = render()
    expect(html.match(/Estimated from this gateway&#x27;s settings/g)).toHaveLength(1)
    ui.data = view(42)
    expect(render()).not.toContain('Estimated')
  })

  it('says when ANTSEED_CLIENT_AGENT_ID on the buyer overrides the saved agent', () => {
    ui.data = { ...view(5), effective: { agentId: 7, source: 'env', client: 'cli', runtime: true } }
    expect(render()).toContain('ANTSEED_CLIENT_AGENT_ID on the buyer overrides the agent set here (#5)')
  })
})

describe('Builders claims without an explorer', () => {
  const owner = '0x0000000000000000000000000000000000000008'
  const unindexed = (): BuildersView => ({
    ...view(42),
    available: true,
    agent: { agentId: 42, owner, firstParty: null, payableAnts: '0', claimableEpochs: [] },
  })

  beforeEach(() => {
    ui.builderClaimable.mockReset().mockReturnValue({ agentId: 42, owner, firstParty: null, payableAnts: '18.6', claimableEpochs: [3, 9] })
  })

  it('keeps the claim controls, with the amount unknown until found on-chain', () => {
    ui.data = unindexed()
    const html = render()
    expect(html).toContain('Rewards not checked yet')
    expect(html).toContain('<button>Find rewards</button>')
    expect(html.match(/Find rewards checks the chain/g)).toHaveLength(1)
    expect(html).not.toContain('not available on this network')
  })

  it('finds the payable epochs on-chain, then opens the claim', () => {
    ui.data = unindexed()
    render()
    click('Find rewards')
    expect(ui.builderClaimable).toHaveBeenCalledTimes(1)
    const html = render()
    expect(ui.modals.get('Claim builders rewards')?.isOpen).toBe(true)
    expect(html).toContain('18.6 ANTS ready to claim')
    expect(html).toContain('<button>Claim</button>')
  })

  it('offers to check again after an empty on-chain lookup, and finds rewards that became payable', () => {
    ui.data = unindexed()
    ui.builderClaimable.mockReturnValue({ agentId: 42, owner, firstParty: null, payableAnts: '0', claimableEpochs: [] })
    render()
    click('Find rewards')
    let html = render()
    expect(html).toContain('Nothing to claim yet')
    expect(html).toContain('<button>Check again</button>')
    expect(ui.modals.get('Claim builders rewards')?.isOpen).not.toBe(true)

    ui.builderClaimable.mockReturnValue({ agentId: 42, owner, firstParty: null, payableAnts: '2', claimableEpochs: [5] })
    click('Check again')
    expect(ui.builderClaimable).toHaveBeenCalledTimes(2)
    html = render()
    expect(html).toContain('2 ANTS ready to claim')
    expect(ui.modals.get('Claim builders rewards')?.isOpen).toBe(true)
  })

  it('ignores rewards found for an agent that is no longer the effective one', () => {
    ui.data = unindexed()
    render()
    click('Find rewards')
    ui.modals.get('Claim builders rewards')?.onClose()
    ui.data = { ...unindexed(), agent: { ...unindexed().agent!, agentId: 7 } }
    expect(render()).toContain('Rewards not checked yet')
  })

  it('says the program is unavailable only without a rewards contract', () => {
    ui.data = view(42)
    expect(render()).toContain('The builders program is not available on this network')
  })
})
