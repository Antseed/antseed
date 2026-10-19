import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatedInvite, Referrals as ReferralsView } from '../api/types'

// There is no DOM here, so state is kept across server renders: hooks take slots
// in call order (the mocked tree below calls useState only in the referrals body
// and its referee panel). The test's render() drops every slot when the body's key
// changes, as React remounts a keyed subtree, and slots a render no longer reaches
// are dropped, as on unmount.
const ui = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  workspaceId: 'ws-a',
  data: undefined as ReferralsView | undefined,
  buttons: new Map<string, () => void>(),
  modals: new Map<string, boolean>(),
  change: undefined as ((event: { target: { value: string } }) => void) | undefined,
  createInvite: undefined as unknown as ReturnType<typeof vi.fn>,
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
  DataTable: () => null,
  LoadingRows: () => null,
  useToast: () => () => {},
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    if (onClick) ui.buttons.set(text(children), onClick)
    return createElement('button', { disabled }, children)
  },
  Modal: ({ isOpen, title, children }: { isOpen: boolean; title: string; children: ReactNode }) => {
    ui.modals.set(title, isOpen)
    return isOpen ? createElement('section', { 'aria-label': title }, children) : null
  },
  TextField: ({ label, value, onChange }: { label: string; value: string; onChange: (event: { target: { value: string } }) => void }) => {
    ui.change = onChange
    return createElement('input', { 'aria-label': label, value, onChange })
  },
}))

vi.mock('../components/ui', () => {
  const box = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  const none = () => null
  return {
    Badge: box, CodeBlock: none, CopyButton: none, EmptyState: none, ErrorAlert: none, Mono: box, PageHeader: none, PageLink: box,
    Panel: box, StatTile: none,
    QueryView: ({ query, children }: { query: { data: ReferralsView | undefined }; children: (data: ReferralsView) => ReactNode }) =>
      query.data === undefined ? null : createElement('div', null, children(query.data)),
  }
})
vi.mock('../components/icons', () => ({ Icon: new Proxy({}, { get: () => () => null }) }))
vi.mock('../components/ChainGate', () => ({ ChainGate: () => null }))
vi.mock('../wallet/ReferralClaim', () => ({ default: () => null }))
vi.mock('../app/context', () => ({ useConsole: () => ({ workspace: { id: ui.workspaceId } }) }))
vi.mock('../api', () => {
  ui.createInvite = vi.fn()
  return { api: { referrals: { get: vi.fn(), createInvite: ui.createInvite, redeem: vi.fn(), clearInvite: vi.fn() } }, isApiError: () => false }
})
vi.mock('../lib/operator', () => ({ useOperator: () => ({ data: undefined }) }))
vi.mock('../lib/queries', () => ({ qk: { referrals: (id: string) => ['referrals', id] }, useChain: () => ({ data: undefined, error: null }) }))
// A write that resolves at once: mutate runs the request and its onSuccess in the same call.
vi.mock('../lib/mutations', () => ({
  useConsoleMutation: (options: { mutationFn: () => unknown; onSuccess?: (data: unknown) => void }) => ({
    mutate: () => options.onSuccess?.(options.mutationFn()),
    isPending: false,
    error: null,
  }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  // Cached data for every workspace, so QueryView never unmounts the body on a switch.
  useQuery: () => ({ data: ui.data, error: null, isLoading: false, refetch: () => {} }),
}))

const { default: Referrals } = await import('./Referrals')

const view = (): ReferralsView => ({
  available: false,
  invitesAvailable: true,
  address: '0x0000000000000000000000000000000000000001',
  invites: null,
  referredCount: 0,
  payableAnts: '0',
  claimableEpochs: [],
  buyers: [],
  referee: {
    state: 'none', referrer: null, pendingInvite: null, inviteExpiresEpoch: null, boundEpoch: null,
    windowEnd: null, weeksLeft: null, payableAnts: '0', claimableEpochs: [], canRedeem: true,
  },
})

const invite: CreatedInvite = { invite: 'code', link: 'https://antseed.com/invite/code', epoch: 3, index: 0, quota: 2, left: 1, expiresEpoch: 7 }

let mountedKey: string | null | undefined
function render() {
  // The page only reads the console context before handing off to its body.
  const tree = (Referrals as () => ReactElement)()
  if (tree.key !== mountedKey) ui.slots = []
  mountedKey = tree.key
  ui.cursor = 0
  ui.buttons.clear()
  ui.modals.clear()
  ui.change = undefined
  const html = renderToStaticMarkup(tree)
  ui.slots.length = ui.cursor
  return html
}

const inviteField = (html: string) => html.match(/<input aria-label="Invite code or link" value="([^"]*)"/)?.[1]
const redeemDisabled = (html: string) => /<button disabled="">Redeem<\/button>/.test(html)
const click = (label: string) => {
  const onClick = ui.buttons.get(label)
  if (!onClick) throw new Error(`no "${label}" button`)
  onClick()
}

beforeEach(() => {
  ui.slots = []
  ui.workspaceId = 'ws-a'
  ui.data = view()
  mountedKey = undefined
  ui.createInvite.mockReset().mockReturnValue(invite)
})

describe('Referrals across workspace switches', () => {
  it('keys the workspace body by workspace id', () => {
    expect((Referrals as () => ReactElement)().key).toBe('ws-a')
    ui.workspaceId = 'ws-b'
    expect((Referrals as () => ReactElement)().key).toBe('ws-b')
  })

  it('keeps an invite draft within a workspace', () => {
    render()
    ui.change?.({ target: { value: 'https://antseed.com/invite/abc' } })
    const html = render()
    expect(inviteField(html)).toBe('https://antseed.com/invite/abc')
    expect(redeemDisabled(html)).toBe(false)
  })

  it('drops an invite draft typed in another workspace', () => {
    render()
    ui.change?.({ target: { value: 'https://antseed.com/invite/abc' } })
    expect(inviteField(render())).toBe('https://antseed.com/invite/abc')

    ui.workspaceId = 'ws-b'
    const html = render()
    expect(inviteField(html)).toBe('')
    expect(redeemDisabled(html)).toBe(true)

    // Switching back does not bring the draft back either.
    ui.workspaceId = 'ws-a'
    expect(inviteField(render())).toBe('')
  })

  it('closes an invite created in another workspace', () => {
    render()
    click('Create invite')
    expect(ui.createInvite).toHaveBeenCalledWith('ws-a')
    render()
    expect(ui.modals.get('Invite created')).toBe(true)

    ui.workspaceId = 'ws-b'
    render()
    expect(ui.modals.get('Invite created')).toBe(false)
  })
})
