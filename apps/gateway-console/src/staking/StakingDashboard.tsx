import { useMemo, type MouseEvent } from 'react'
import { AntsDashboard, type AntsHost, type Page } from '@antseed/ants-web/embed'
import { API_BASE, CSRF_HEADER } from '../api/client'
import { useConsole } from '../app/context'
import { isDarkNow } from '../app/theme'
import { ChainGate } from '../components/ChainGate'
import { useChain } from '../lib/queries'
import { href, navigate, subscribeLocation } from '../lib/router'
import { WalletProvider } from '../wallet/provider'

const PREFIX = 'staking'

/** The console path of a dashboard path: its rewards are the console's Rewards page, the rest live under Staking. */
function consolePath(path: string): string {
  return path === 'rewards' || path.startsWith('rewards/') || path.startsWith('rewards?') ? 'rewards' : `${PREFIX}/${path}`
}

/** The dashboard path shown on the Staking page: `/console/staking/positions?x=1` → `positions?x=1`. */
function stakingPath(): string {
  const base = href(PREFIX)
  const { pathname, search } = window.location
  const below = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : ''
  return `${below}${search}`
}

const noop = () => undefined

/**
 * The staking dashboard's pages, served for this workspace's buyer account
 * through the console API and signed with the member's wallet. `pages` are the
 * dashboard pages this console page shows; with one page it stays at that page.
 */
export function StakingDashboard({ pages, buyerRewards }: { pages: readonly Page[]; buyerRewards: boolean }) {
  const { workspace } = useConsole()
  const chain = useChain()
  const routed = pages.length > 1
  const host = useMemo<Omit<AntsHost, 'embedded' | 'portalTarget'>>(() => ({
    apiUrl: (path) => `${API_BASE}/workspaces/${encodeURIComponent(workspace.id)}/ants/${path.replace(/^\/api\//, '')}`,
    headers: () => ({ [CSRF_HEADER]: '1' }),
    href: (path) => href(consolePath(path)),
    currentPath: routed ? stakingPath : () => pages[0] ?? '',
    replace: routed ? (path) => navigate(consolePath(path), { replace: true }) : noop,
    subscribe: routed ? subscribeLocation : () => noop,
    pages,
    buyerRewards,
  }), [workspace.id, pages, buyerRewards, routed])

  // The dashboard's links are plain anchors; keep plain clicks inside the console app.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element).closest('a')
    const target = anchor?.getAttribute('href')
    const root = href('')
    if (!anchor || anchor.target || !target?.startsWith(root)) return
    event.preventDefault()
    navigate(target.slice(root.length))
  }

  return (
    <div onClick={onClick}>
      <ChainGate chain={chain.data} error={chain.error}>
        {(info) => (
          <WalletProvider chain={info}>
            <AntsDashboard key={workspace.id} host={host} theme={isDarkNow() ? 'dark' : 'light'} />
          </WalletProvider>
        )}
      </ChainGate>
    </div>
  )
}
