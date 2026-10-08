import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, ToastProvider } from '@antseed/ui'
import { isApiError } from '../api'
import type { Me } from '../api/types'
import { Shell } from '../components/Shell'
import { ErrorAlert, LoadingRows } from '../components/ui'
import { canOpen, viewerFor, type PageId, NAV_ITEMS } from '../lib/nav'
import { useMe } from '../lib/queries'
import { navigate, useLocation } from '../lib/router'
import { EnrollPage, LoginPage } from '../pages/Auth'
import { ConsoleContext, pickWorkspace, rememberedWorkspace, rememberWorkspace, type ConsoleContextValue } from './context'

const pages: Record<PageId, ComponentType> = {
  overview: lazy(() => import('../pages/Overview')),
  activity: lazy(() => import('../pages/Activity')),
  logs: lazy(() => import('../pages/Logs')),
  keys: lazy(() => import('../pages/Keys')),
  members: lazy(() => import('../pages/Members')),
  workspaces: lazy(() => import('../pages/Workspaces')),
  wallet: lazy(() => import('../pages/Wallet')),
  rewards: lazy(() => import('../pages/Rewards')),
  network: lazy(() => import('../pages/Network')),
  routing: lazy(() => import('../pages/Routing')),
  presets: lazy(() => import('../pages/Presets')),
  audit: lazy(() => import('../pages/Audit')),
  settings: lazy(() => import('../pages/Settings')),
}
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

function isPageId(value: string): value is PageId {
  return NAV_ITEMS.some((item) => item.id === value)
}

function MemberConsole({ me, page }: { me: Me; page: string }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => pickWorkspace(me, rememberedWorkspace())?.id ?? null)
  const workspace = pickWorkspace(me, workspaceId)
  const queryClientInstance = useQueryClient()

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

  if (!value) {
    return <div className="gc-centered"><Alert tone="warning" title="No workspace">You are not a member of any workspace yet. Ask an admin to add you.</Alert></div>
  }
  const pageId: PageId = isPageId(page) ? page : 'overview'
  const allowed = canOpen(pageId, value.viewer)
  const Page = pages[pageId]
  return (
    <ConsoleContext.Provider value={value}>
      <Shell page={pageId}>
        <Suspense fallback={<LoadingRows rows={6} />}>
          {allowed ? <Page /> : <Alert tone="warning" title="Not available">Your role cannot open this page.</Alert>}
        </Suspense>
      </Shell>
    </ConsoleContext.Provider>
  )
}

function SessionGate({ page }: { page: string }) {
  const me = useMe()
  const unauthorized = isApiError(me.error) && me.error.status === 401
  useEffect(() => {
    if (unauthorized) navigate('login', { replace: true })
  }, [unauthorized])

  if (me.isLoading || unauthorized) return <div className="gc-centered"><LoadingRows rows={3} /></div>
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
