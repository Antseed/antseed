import { lazy, Suspense, useState } from 'react'
import { Alert, Button, Disclosure, LoadingRows, Modal, useToast } from '@antseed/ui'
import { errorMessage } from '../api'
import { AccountModal } from '../components/AccountModal'
import { ChainGate } from '../components/ChainGate'
import { Badge, CopyButton, Panel, QueryView } from '../components/ui'
import { isSetAddress } from '../lib/chain'
import { formatRelative, shortId } from '../lib/format'
import { operatorView, useOperator, useOperatorRefresh, type OperatorState } from '../lib/operator'
import { useChain } from '../lib/queries'

const OperatorActions = lazy(() => import('./OperatorActions'))

const BADGE_TONE = { info: 'neutral', success: 'success', warning: 'warning', danger: 'danger' } as const

export type OperatorAction = 'authorize' | 'manage'
type Action = OperatorAction

const ACTION_TITLE: Record<Action, string> = { authorize: 'Authorize a wallet', manage: 'Transfer or remove the authorized wallet' }

/**
 * "Authorized wallet": who receives this workspace's withdrawals and ANTS
 * rewards, how that wallet relates to you, and what you can do about it.
 * A compact summary; every action opens in a dialog.
 */
export function OperatorPanel({ workspaceId, action, onActionChange }: {
  workspaceId: string
  /** Controlled dialog, so other parts of the page (a withdraw or close gate) can open "Authorize a wallet". */
  action?: OperatorAction | null
  onActionChange?: (action: OperatorAction | null) => void
}) {
  const operator = useOperator(workspaceId)
  const chain = useChain()
  const toast = useToast()
  const { apply, refresh } = useOperatorRefresh(workspaceId)
  const [ownOpen, setOwnOpen] = useState<Action | null>(null)
  const open = action !== undefined ? action : ownOpen
  const setOpen = (next: Action | null) => (onActionChange ? onActionChange(next) : setOwnOpen(next))
  const [linking, setLinking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<unknown>(null)

  async function reload() {
    setRefreshing(true)
    setRefreshError(null)
    try { await refresh() } catch (error) { setRefreshError(error) } finally { setRefreshing(false) }
  }

  const description = 'Receives this workspace\'s withdrawals and ANTS rewards, and is the only wallet that can sign them.'
  return (
    <Panel title="Authorized wallet" description={description}>
      <QueryView query={operator} rows={2}>
        {(state) => (
          <OperatorSummary state={state} explorerUrl={chain.data?.explorerUrl ?? null} refreshing={refreshing} onReload={() => void reload()}
            onAction={setOpen} onLink={() => setLinking(true)} />
        )}
      </QueryView>
      {refreshError ? <Alert tone="danger">{errorMessage(refreshError)}</Alert> : null}

      <Modal isOpen={open !== null && operator.data !== undefined} onClose={() => setOpen(null)} size="md" title={open ? ACTION_TITLE[open] : ''}
        subtitle={open === 'manage' && operator.data
          ? `Signed by ${shortId(operator.data.operator)} itself; the gateway cannot do it.`
          : 'Withdrawals and ANTS rewards will go to the wallet you authorize, and only it can hand the role on.'}>
        {open && operator.data && (
          <ChainGate chain={chain.data} error={chain.error}>
            {(info) => (
              <Suspense fallback={<LoadingRows rows={2} />}>
                <OperatorActions mode={open} workspaceId={workspaceId} state={operator.data!} chain={info}
                  onStale={() => void reload()}
                  onChanged={(next) => {
                    apply(next)
                    setOpen(null)
                    toast(isSetAddress(next.operator) ? `Authorized wallet is now ${shortId(next.operator)}` : 'Authorized wallet removed')
                  }} />
              </Suspense>
            )}
          </ChainGate>
        )}
      </Modal>

      {linking && operator.data && (
        <AccountModal isOpen startWith="wallet" onClose={() => setLinking(false)}
          intro={<p className="gc-muted">Connect <code className="gc-mono">{shortId(operator.data.operator)}</code> and sign the message to add it as one of your sign-in methods. It then shows here as your wallet, and you can manage it.</p>}
          onCredentialAdded={() => {
            void reload()
            toast('Wallet linked to your account')
          }} />
      )}
    </Panel>
  )
}

function OperatorSummary({ state, explorerUrl, refreshing, onReload, onAction, onLink }: {
  state: OperatorState; explorerUrl: string | null; refreshing: boolean
  onReload: () => void; onAction: (action: Action) => void; onLink: () => void
}) {
  const view = operatorView(state, null)
  const set = isSetAddress(state.operator)
  const explorer = explorerUrl && set ? `${explorerUrl.replace(/\/+$/, '')}/address/${state.operator}` : null
  const manageable = set && state.relation !== 'self'
  return (
    <div className="gc-operator">
      <div className="gc-operator__main">
        <div className="gc-operator__title">
          <span className="gc-strong">{view.title}</span>
          {set && <CopyButton iconOnly value={state.operator!} label="Copy address" />}
          <Badge tone={BADGE_TONE[view.tone]}>{view.badge}</Badge>
        </div>
        <p className="gc-operator__summary">{view.summary}</p>
        <p className="gc-fineprint gc-operator__meta">
          {explorer && <><a className="gc-link" href={explorer} target="_blank" rel="noopener noreferrer">explorer</a> · </>}
          Checked {formatRelative(state.checkedAt)} ·{' '}
          <Button variant="link" size="sm" disabled={refreshing} onClick={onReload}>{refreshing ? 'checking…' : 'check again'}</Button>
        </p>
      </div>
      <div className="gc-operator__actions">
        {view.canAuthorize && <Button size="sm" onClick={() => onAction('authorize')}>Authorize a wallet</Button>}
        {view.canLink && <Button size="sm" onClick={onLink}>Link to my account</Button>}
        {manageable && <Button size="sm" variant="outline" onClick={() => onAction('manage')}>Transfer or remove</Button>}
      </div>
      {(view.body !== view.summary || (state.relation === 'none' && !state.canAuthorize)) && (
        <Disclosure className="gc-operator__details" title="What does this mean?">
          <p className="gc-muted">{view.body}</p>
          {state.relation === 'none' && !state.canAuthorize && (
            <p className="gc-fineprint">Only the organization owner can authorize a wallet, with one of their own sign-in wallets added at least 24 hours ago.</p>
          )}
        </Disclosure>
      )}
    </div>
  )
}
