import { Component, lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, ToastProvider } from '@antseed/ui'
import { isApiError } from '../api'
import type { Me } from '../api/types'
import { Shell } from '../components/Shell'
import { SellerShell } from '../components/SellerShell'
import { ErrorAlert, LoadingRows } from '../components/ui'
import { canOpen, isSellerPage, movedPagePath, viewerFor, type PageId, NAV_ITEMS } from '../lib/nav'
import { useMe } from '../lib/queries'
import { navigate, parseLocation, useLocation } from '../lib/router'
import { EnrollPage, LoginPage } from '../pages/Auth'
import { ConsoleContext, pickWorkspace, rememberedWorkspace, rememberWorkspace, type ConsoleContextValue } from './context'

const loaders: Record<PageId, () => Promise<{ default: ComponentType }>> = {
  overview: () => import('../pages/Overview'),
  chat: () => import('../pages/Chat'),
  activity: () => import('../pages/Activity'),
  logs: () => import('../pages/Logs'),
  keys: () => import('../pages/Keys'),
  members: () => import('../pages/Members'),
  workspaces: () => import('../pages/Workspaces'),
  wallet: () => import('../pages/Wallet'),
  rewards: () => import('../pages/Rewards'),
  staking: () => import('../pages/Staking'),
  providers: () => import('../pages/Providers'),
  models: () => import('../pages/Models'),
  routing: () => import('../pages/Routing'),
  presets: () => import('../pages/Presets'),
  audit: () => import('../pages/Audit'),
  settings: () => import('../pages/Settings'),
  seller: () => import('../pages/Seller'),
  'seller-logs': () => import('../pages/SellerLogs'),
  'seller-market': () => import('../pages/SellerMarket'),
  'seller-reputation': () => import('../pages/SellerReputation'),
  'seller-promote': () => import('../pages/SellerPromote'),
  'seller-settings': () => import('../pages/SellerSettings'),
}
const pages = {} as Record<PageId, ComponentType>
for (const id of Object.keys(loaders) as PageId[]) pages[id] = lazy(loaders[id])

// Download the opened page's code while the session is checked, instead of after; then Chat in the
// background, the page people open most. Imports are cached, so the lazy pages reuse these downloads.
const opened = parseLocation(window.location.pathname).page
if (isPageId(opened)) void loaders[opened]().catch(() => undefined)
const prefetchChat = () => { void loaders.chat().catch(() => undefined) }
if ('requestIdleCallback' in window) window.requestIdleCallback(prefetchChat, { timeout: 4000 })
else setTimeout(prefetchChat, 2000)

const KeyHolderView = lazy(() => import('../pages/KeyHolder'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // Auth and permission errors will not fix themselves on retry.
      retry: (count, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
})

/** Keeps a page that throws while rendering from blanking the whole console. */
class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; error?: unknown }> {
  override state: { failed: boolean; error?: unknown } = { failed: false }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return <ErrorAlert error={this.state.error} title="This page failed to load" onRetry={() => this.setState({ failed: false, error: undefined })} />
  }
}

function isPageId(value: string): value is PageId {
  return NAV_ITEMS.some((item) => item.id === value)
}

function MemberConsole({ me, page }: { me: Me; page: string }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => pickWorkspace(me, rememberedWorkspace())?.id ?? null)
  const workspace = pickWorkspace(me, workspaceId)
  const queryClientInstance = useQueryClient()
  const location = useLocation()
  const moved = movedPagePath(location.page, location.rest)
  useEffect(() => {
    if (moved) navigate(moved, { replace: true })
  }, [moved])

  const value = useMemo<ConsoleContextValue | null>(() => {
    if (!workspace) return null
    const viewer = viewerFor({ kind: 'member', me }, workspace.id)!
    return {
      me,
      workspace,
      workspaceRole: viewer.workspaceRole,
      viewer,
      setWorkspaceId: (id) => {
        rememberWorkspace(id)
        setWorkspaceId(id)
        void queryClientInstance.invalidateQueries()
      },
    }
  }, [me, workspace, queryClientInstance])

  if (moved) return <div className="gc-centered"><LoadingRows rows={3} /></div>
  if (!value) {
    return <div className="gc-centered"><Alert tone="warning" title="No workspace">You are not a member of any workspace yet. Ask an admin to add you.</Alert></div>
  }
  const pageId: PageId = isPageId(page) ? page : 'overview'
  const allowed = canOpen(pageId, value.viewer)
  const Page = pages[pageId]
  return (
    <ConsoleContext.Provider value={value}>
      <Shell page={pageId}>
        {/* Keyed by page only: opening an item in a side panel keeps the list's state. */}
        <PageErrorBoundary key={location.page}>
          <Suspense fallback={<LoadingRows rows={6} />}>
            {allowed ? <Page /> : <Alert tone="warning" title="Not available">Your role cannot open this page.</Alert>}
          </Suspense>
        </PageErrorBoundary>
      </Shell>
    </ConsoleContext.Provider>
  )
}

/** `antseed seller dashboard`: the Seller pages alone, in a frame without workspaces or accounts. */
function SellerConsole({ version }: { version: string }) {
  const location = useLocation()
  const page = isSellerPage(location.page) ? location.page as PageId : 'seller'
  useEffect(() => {
    if (location.page !== page) navigate(page, { replace: true })
  }, [location.page, page])
  const Page = pages[page]
  return (
    <SellerShell version={version} page={page}>
      <PageErrorBoundary key={page}>
        <Suspense fallback={<LoadingRows rows={6} />}><Page /></Suspense>
      </PageErrorBoundary>
    </SellerShell>
  )
}

function SessionGate({ page }: { page: string }) {
  const me = useMe()
  // The seller dashboard has no sign-in page: its session comes from the link the CLI printed.
  const sellerLink = isApiError(me.error, 'seller_link_required')
  const unauthorized = isApiError(me.error) && me.error.status === 401 && !sellerLink
  useEffect(() => {
    if (unauthorized) navigate('login', { replace: true })
  }, [unauthorized])

  if (me.isLoading || unauthorized) return <div className="gc-centered"><LoadingRows rows={3} /></div>
  if (sellerLink) {
    return <div className="gc-centered"><Alert tone="warning" title="Open the dashboard link">This seller dashboard opens from the link that antseed seller dashboard printed. Run it again for a fresh link.</Alert></div>
  }
  if (me.error) {
    return (
      <div className="gc-centered gc-stack">
        <ErrorAlert error={me.error} title="Could not open the console" onRetry={() => void me.refetch()} />
        <Button variant="ghost" onClick={() => navigate('login')}>Go to sign in</Button>
      </div>
    )
  }
  if (!me.data) return null
  if (me.data.kind === 'key') return <Suspense fallback={<LoadingRows rows={6} />}><KeyHolderView /></Suspense>
  if (me.data.kind === 'seller') return <SellerConsole version={me.data.me.version} />
  return <MemberConsole me={me.data.me} page={page} />
}

function Routes() {
  const location = useLocation()
  if (location.page === 'login') return <LoginPage />
  if (location.page === 'setup' || location.page === 'invite' || location.page === 'recover') return <EnrollPage kind={location.page} />
  return <SessionGate page={location.page} />
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Routes />
      </ToastProvider>
    </QueryClientProvider>
  )
}
