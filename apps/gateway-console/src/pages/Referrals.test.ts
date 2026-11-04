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
  claimable: undefined as unknown as ReturnType<typeof vi.fn>,
  operator: null as string | null,
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
  ui.claimable = vi.fn()
  return { api: { referrals: { get: vi.fn(), createInvite: ui.createInvite, redeem: vi.fn(), clearInvite: vi.fn(), claimable: ui.claimable } }, isApiError: () => false }
})
vi.mock('../lib/operator', () => ({ useOperator: () => ({ data: ui.operator ? { operator: ui.operator } : undefined }) }))
vi.mock('../lib/queries', () => ({ qk: { referrals: (id: string) => ['referrals', id] }, useChain: () => ({ data: undefined, error: null }) }))
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
    windowEnd: null, weeksLeft: null, payableAnts: '0', claimableEpochs: [], canRedeem: true, indexed: false,
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
  ui.claimable.mockReset().mockReturnValue({
    referrer: { payableAnts: '12.5', claimableEpochs: [3] },
    referee: { payableAnts: '0', claimableEpochs: [] },
  })
  ui.operator = null
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

describe('Referrals claims without an explorer', () => {
  const bound = (): ReferralsView => ({
    ...view(),
    referee: { ...view().referee, state: 'bound', referrer: '0x0000000000000000000000000000000000000002', canRedeem: false, indexed: false },
  })

  it('keeps the referral and bonus claim controls, with the amounts unknown until found on-chain', () => {
    ui.data = bound()
    const html = render()
    expect(html).toContain('Referral rewards not checked yet')
    expect(html).toContain('Bonus not checked yet.')
    // No bonus window is known, so none is claimed to be over.
    expect(html).not.toContain('Bonus window over')
    expect(html.match(/>Find rewards</g)).toHaveLength(2)
    expect(html.match(/Find rewards checks the chain/g)).toHaveLength(1)
  })

  it('finds the referral epochs on-chain, then claims them with the authorized wallet', () => {
    ui.operator = '0x0000000000000000000000000000000000000009'
    render()
    click('Find rewards')
    expect(ui.claimable).toHaveBeenCalledWith('ws-a')
    const html = render()
    expect(ui.modals.get('Claim referral rewards')).toBe(true)
    expect(html).toContain('12.5 ANTS referral rewards ready')
    expect(html).not.toContain('Referral rewards not checked yet')
  })

  it('finds the invite bonus on-chain, then claims it', () => {
    ui.data = bound()
    ui.operator = '0x0000000000000000000000000000000000000009'
    ui.claimable.mockReturnValue({ referrer: { payableAnts: '0', claimableEpochs: [] }, referee: { payableAnts: '6.4', claimableEpochs: [4] } })
    render()
    // The bonus row's Find rewards (rendered after the referral row's).
    click('Find rewards')
    const html = render()
    expect(ui.modals.get('Claim the invite bonus')).toBe(true)
    expect(html).toContain('6.4 ANTS bonus ready.')
    expect(html).toContain('No referral rewards to claim yet')
  })

  it('shows what was found when nothing can be paid yet, without opening a claim', () => {
    ui.claimable.mockReturnValue({ referrer: { payableAnts: '0', claimableEpochs: [] }, referee: { payableAnts: '0', claimableEpochs: [] } })
    ui.operator = '0x0000000000000000000000000000000000000009'
    render()
    click('Find rewards')
    const html = render()
    expect(html).toContain('No referral rewards to claim yet')
    expect(ui.modals.get('Claim referral rewards')).toBeUndefined()
    // Weeks become payable later: the lookup stays available instead of a disabled Claim.
    expect(html).toContain('>Check again<')
    expect(html).not.toContain('>Claim<')

    // Rewards become payable; checking again on the same page finds and opens them.
    ui.claimable.mockReturnValue({ referrer: { payableAnts: '3', claimableEpochs: [4] }, referee: { payableAnts: '0', claimableEpochs: [] } })
    click('Check again')
    expect(ui.claimable).toHaveBeenCalledTimes(2)
    render()
    expect(ui.modals.get('Claim referral rewards')).toBe(true)
  })

  it('claims the indexed rewards directly when the explorer reports them', () => {
    ui.data = { ...bound(), available: true, payableAnts: '4', claimableEpochs: [2], referee: { ...bound().referee, indexed: true, payableAnts: '1', claimableEpochs: [2] } }
    const html = render()
    expect(html).not.toContain('Find rewards')
    expect(html).toContain('4 ANTS referral rewards ready')
  })
})
