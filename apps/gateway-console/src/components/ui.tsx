import type { ReactNode } from 'react'
import { Alert, Badge, Button, LoadingRows } from '@antseed/ui'
import { errorMessage } from '../api'
import { href, linkHandler } from '../lib/router'

/** Shared primitives and page blocks live in @antseed/ui; re-exported so pages import one module. */
export {
  ActionMenu, Badge, CodeBlock, ConfirmDialog, CopyButton, copyText, DetailList, EmptyState, LoadingRows, PageHeader, Panel, SecretReveal,
  Segmented, SelectField, StatTile, Switch, TabPanel, Tabs, TextAreaField,
} from '@antseed/ui'
export type { ActionMenuItem, BadgeTone } from '@antseed/ui'

export function ErrorAlert({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <Alert tone="danger" title={title} action={onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button> : undefined}>
      {errorMessage(error)}
    </Alert>
  )
}

/** Renders loading/error states for a react-query result, then `children(data)`. */
export function QueryView<T>({ query, children, rows }: {
  query: { data: T | undefined; error: unknown; isLoading: boolean; refetch: () => unknown }
  children: (data: T) => ReactNode
  rows?: number
}) {
  if (query.isLoading) return <LoadingRows rows={rows} />
  if (query.error) return <ErrorAlert error={query.error} onRetry={() => void query.refetch()} />
  if (query.data === undefined) return null
  return <>{children(query.data)}</>
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return <code className="gc-mono" title={title}>{children}</code>
}

/** A label over a value, for balance and status rows. */
export function Figure({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="gc-figure">
      <div className="gc-figure__label">{label}</div>
      <div className={strong ? 'gc-figure__value gc-figure__value--strong' : 'gc-figure__value'}>{value}</div>
    </div>
  )
}

/** A name with the hint of its secret under it (API keys, management tokens). */
export function NameWithHint({ name, hint }: { name: string; hint: string }) {
  return <div><div className="gc-strong">{name}</div><code className="gc-mono gc-muted">{hint}</code></div>
}

/** "Never", an Expired badge once past, or the expiry in `format`. */
export function Expiry({ at, format }: { at: number | null; format: (epochMs: number) => string }) {
  if (at === null) return <>Never</>
  if (at < Date.now()) return <Badge tone="warning">Expired</Badge>
  return <>{format(at)}</>
}

export const STALE_CHAIN_HINT = 'Showing last known values — the chain RPC is busy.'

/** A quiet note under chain-backed figures the gateway served from its last good read. */
export function StaleHint({ stale }: { stale?: boolean }) {
  if (!stale) return null
  return <p className="gc-muted" role="status">{STALE_CHAIN_HINT}</p>
}

/** A link to another console page that navigates client-side. */
export function PageLink({ to, children }: { to: string; children: ReactNode }) {
  return <a className="gc-link" href={href(to)} onClick={linkHandler(to)}>{children}</a>
}
