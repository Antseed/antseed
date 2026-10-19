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
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    if (onClick) ui.buttons.set(text(children), onClick)
    return createElement('button', null, children)
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
vi.mock('../api', () => ({ api: { referrals: { builders: vi.fn(), setBuilderAgent: vi.fn() } } }))
vi.mock('../lib/queries', () => ({ qk: { builders: ['builders'] }, useChain: () => ({ data: undefined, error: null }) }))
vi.mock('../lib/mutations', () => ({ useConsoleMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) }))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useQuery: () => ({ data: ui.data, error: null, isLoading: false, refetch: () => {} }),
}))

const { default: Builders } = await import('./Builders')

const view = (agentId: number | null): BuildersView => ({
  available: false,
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
