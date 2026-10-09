import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, DataTable, LoadingRows, Modal, useToast } from '@antseed/ui'
import { api, errorMessage } from '../api'
import type { Channel, Wallet as WalletInfo } from '../api/types'
import { useConsole } from '../app/context'
import { ChainGate } from '../components/ChainGate'
import { Icon } from '../components/icons'
import {
  Badge, CopyButton, EmptyState, Figure, Mono, PageHeader, Panel, QueryView, StaleHint, Switch,
} from '../components/ui'
import { isSetAddress } from '../lib/chain'
import { formatDateTime, formatUsd, shortId, usdcToNumber } from '../lib/format'
import { useOpenChannels } from '../lib/attention'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin } from '../lib/nav'
import { qk, useChain, useWallet } from '../lib/queries'
import { useOperator } from '../lib/operator'
import {
  channelAction, channelStatusLabel, channelStatusTone, cooperativeCloseError, isEntireBalanceLocked, isOpenChannel, pendingSpend, unspent, walletUsdcMessage, withdrawableAt, withdrawableSummary,
} from '../lib/channels'
import { AddFunds } from '../wallet/AddFunds'
import { OperatorPanel, type OperatorAction } from '../wallet/OperatorPanel'

const WalletFunding = lazy(() => import('../wallet/WalletFunding'))
const ChannelClose = lazy(() => import('../wallet/ChannelClose'))

type CloseDialog = { channel: Channel; mode: 'cooperative' | 'request' | 'withdraw' }

/** Re-renders every `ms` while `active`, for countdowns. */
function useNow(active: boolean, ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [active, ms])
  return now
}

/**
 * Close a channel the way the desktop does: ask the seller first (instant,
 * no transaction); when that fails, or the seller cannot, the authorized
 * wallet requests an on-chain close, then withdraws the unused reserve once
 * the 15-minute grace period ends.
 */
function Channels({ workspaceId, canCooperate, onAuthorize }: { workspaceId: string; canCooperate: boolean; onAuthorize: () => void }) {
  const [all, setAll] = useState(false)
  const [dialog, setDialog] = useState<CloseDialog | null>(null)
  // Channels whose cooperative close failed in this session: their row offers the on-chain close.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const queryClient = useQueryClient()
  const toast = useToast()
  const chain = useChain()
  const channels = useQuery({ queryKey: qk.channels(workspaceId, all), queryFn: () => api.wallet.channels(workspaceId, all) })
  const rows = channels.data ?? []
  const closing = rows.some((channel) => channel.status === 'closing')
  const now = useNow(closing)

  /** Re-read from the chain now (the gateway otherwise caches channel states for 30 s). */
  const reload = async () => {
    const fresh = await api.wallet.channels(workspaceId, all, true)
    queryClient.setQueryData(qk.channels(workspaceId, all), fresh)
    void queryClient.invalidateQueries({ queryKey: ['channels', workspaceId] })
    void queryClient.invalidateQueries({ queryKey: qk.wallet(workspaceId) })
  }

  // A countdown reaching zero turns the row into "ready to withdraw": re-read once it does.
  const nextReady = rows.map(withdrawableAt).filter((at): at is number => at !== null && at > now).sort((a, b) => a - b)[0]
  useEffect(() => {
    if (nextReady === undefined) return
    const timer = setTimeout(() => void reload().catch(() => undefined), Math.max(1_000, nextReady - Date.now() + 5_000))
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextReady])

  const close = useConsoleMutation({
    mutationFn: (channel: Channel) => api.wallet.closeChannel(workspaceId, channel.peerId),
    onSuccess: () => {
      setDialog(null)
      toast('Channel closed by the seller')
    },
    onError: (_error, channel) => setFailed((prev) => new Set(prev).add(channel.channelId)),
    invalidate: [['channels', workspaceId], qk.wallet(workspaceId)],
  })

  const open = (channel: Channel, cooperativeFailed = failed.has(channel.channelId)) => {
    close.reset()
    const action = channelAction(channel, cooperativeFailed || !canCooperate)
    if (action === 'cooperative') setDialog({ channel, mode: 'cooperative' })
    else if (action === 'on-chain') setDialog({ channel, mode: 'request' })
    else if (action === 'withdraw') setDialog({ channel, mode: 'withdraw' })
  }

  const ready = withdrawableSummary(rows)
  const seller = (channel: Channel) => channel.sellerName ?? shortId(channel.peerId)
  return (
    <section id="gc-channels" className="gc-anchor">
    <Panel flush title="Payment channels" description="Funds reserved with sellers. Closing a channel returns what was not spent."
      actions={<Switch checked={all} onChange={setAll} label="Include closed" />}>
      {ready.count > 0 && (
        <Alert tone="warning" title={`${ready.count} channel${ready.count === 1 ? '' : 's'} ready to withdraw`}
          action={<Button size="sm" onClick={() => open(rows.find((channel) => channel.status === 'withdrawable')!)}>Withdraw</Button>}>
          About {formatUsd(ready.amount)} of unused reserve can return to the balance. The authorized wallet signs the withdrawal.
        </Alert>
      )}
      <QueryView query={channels}>
        {(list) => (
          <DataTable<Channel> label="Payment channels" rows={list} rowKey={(channel) => channel.channelId}
            rowLabel={(channel) => `channel with ${seller(channel)}`}
            actions={(channel) => {
              const action = channelAction(channel, failed.has(channel.channelId) || !canCooperate)
              return [
                action === 'cooperative' && { label: 'Close channel', onSelect: () => open(channel) },
                (action === 'cooperative' || action === 'on-chain') && { label: 'Close on chain', onSelect: () => open(channel, true) },
                action === 'withdraw' && { label: 'Withdraw reserve', onSelect: () => open(channel) },
              ]
            }}
            empty={<EmptyState icon={<Icon.wallet size={18} />} title={all ? 'No channels yet' : 'No open channels'} body="A channel opens the first time a seller serves this workspace." />}
            columns={[
              { key: 'seller', header: 'Seller', render: (channel) => channel.sellerName ?? <Mono title={channel.peerId}>{shortId(channel.peerId)}</Mono> },
              { key: 'status', header: 'Status', render: (channel) => <Badge tone={channelStatusTone(channel)}>{channelStatusLabel(channel, now)}</Badge> },
              { key: 'reserved', header: 'Reserved', align: 'right', render: (channel) => formatUsd(channel.reserved) },
              { key: 'spent', header: 'Spent', align: 'right', render: (channel) => formatUsd(channel.spent) },
              { key: 'returns', header: 'Returns on close', align: 'right', secondary: true, optional: true, render: (channel) => (isOpenChannel(channel) ? formatUsd(unspent(channel)) : '—') },
              { key: 'opened', header: 'Opened', secondary: true, render: (channel) => formatDateTime(channel.openedAt) },
            ]} />
        )}
      </QueryView>
      {!canCooperate && rows.some((channel) => channel.canCooperativeClose) && (
        <p className="gc-fineprint gc-panel-note">Asking a seller to close needs an organization admin; you can still close on chain with the authorized wallet.</p>
      )}

      <Modal isOpen={dialog?.mode === 'cooperative'} onClose={() => { setDialog(null); close.reset() }} size="md" title="Close this channel?"
        subtitle={dialog ? `With ${seller(dialog.channel)}. About ${formatUsd(unspent(dialog.channel))} returns to the balance.` : undefined}
        footer={dialog && (
          <div className="gc-actions">
            <Button variant="ghost" onClick={() => { setDialog(null); close.reset() }}>Cancel</Button>
            {close.error ? (
              <>
                <Button variant="outline" disabled={close.isPending} onClick={() => close.mutate(dialog.channel)}>Try again</Button>
                <Button onClick={() => { close.reset(); setDialog({ channel: dialog.channel, mode: 'request' }) }}>Close on chain instead</Button>
              </>
            ) : (
              <Button disabled={close.isPending} onClick={() => close.mutate(dialog.channel)}>{close.isPending ? 'Asking the seller…' : 'Close channel'}</Button>
            )}
          </div>
        )}>
        <div className="gc-stack">
          <p className="gc-muted">The seller settles what was spent and the rest returns to your available balance at once. A new channel opens if this seller is used again.</p>
          {close.isPending && <p className="gc-fineprint">Waiting for the seller (up to a minute)…</p>}
          {close.error ? (
            <Alert tone="danger" title="The seller did not close it">{cooperativeCloseError(errorMessage(close.error))}</Alert>
          ) : null}
        </div>
      </Modal>

      <Modal isOpen={dialog?.mode === 'request' || dialog?.mode === 'withdraw'} onClose={() => setDialog(null)} size="md"
        title={dialog?.mode === 'withdraw' ? 'Withdraw the unused reserve' : 'Close on chain'}
        subtitle={dialog ? `Channel with ${seller(dialog.channel)}. Does not need the seller.` : undefined}>
        {dialog && dialog.mode !== 'cooperative' && (
          <ChainGate chain={chain.data} error={chain.error}>
            {(info) => (
              <Suspense fallback={<LoadingRows rows={2} />}>
                <ChannelClose workspaceId={workspaceId} channel={dialog.channel} chain={info} step={dialog.mode as 'request' | 'withdraw'}
                  onAuthorize={() => { setDialog(null); onAuthorize() }}
                  onDone={(step) => {
                    void reload().catch(() => undefined)
                    if (step === 'request') toast('Close requested. Withdraw in 15 minutes.')
                    else { toast('Reserve returned to the balance'); setDialog(null) }
                  }} />
              </Suspense>
            )}
          </ChainGate>
        )}
      </Modal>
    </Panel>
    </section>
  )
}

function BalancePanel({ wallet, workspaceId, onWithdraw }: { wallet: WalletInfo; workspaceId: string; onWithdraw: () => void }) {
  const channels = useOpenChannels(workspaceId)
  const pending = channels.data ? pendingSpend(channels.data) : null
  const showChannels = () => document.getElementById('gc-channels')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <Panel title="Balance" actions={<Button size="sm" variant="outline" onClick={onWithdraw}>Withdraw</Button>}>
      {isEntireBalanceLocked(wallet) && (
        <Alert tone="warning" title="The whole balance is reserved in channels" action={<Button size="sm" variant="outline" onClick={showChannels}>Manage channels</Button>}>
          Nothing is available for new sellers or withdrawals. Close channels you no longer use to return their unused reserve, or add funds.
        </Alert>
      )}
      <div className="gc-grid gc-grid--4 gc-figures">
        <Figure label="Available" value={formatUsd(wallet.available)} strong />
        <Figure label="Reserved in channels" value={formatUsd(wallet.reserved)} />
        <Figure label="Authorized, not yet charged" value={pending === null ? '…' : formatUsd(pending)} />
        <Figure label="Credit limit" value={wallet.creditLimit === null ? 'None' : formatUsd(wallet.creditLimit)} />
      </div>
      {usdcToNumber(wallet.walletUsdc) > 0 && (
        <p className="gc-fineprint gc-wallet-meta">{formatUsd(wallet.walletUsdc)} in the wallet, not deposited yet. {walletUsdcMessage(wallet)}</p>
      )}
      <p className="gc-fineprint gc-wallet-meta">
        Workspace wallet <Mono title={wallet.address}>{shortId(wallet.address)}</Mono> <CopyButton iconOnly value={wallet.address} label="Copy address" />
        <span aria-hidden="true">·</span> Authorized spend is charged from channel reserves when sellers settle. Withdrawals go to the authorized wallet below.
      </p>
    </Panel>
  )
}

/** Withdrawals are signed by, and paid to, the authorized wallet; the dialog says so and gates on it. */
function WithdrawModal({ wallet, workspaceId, isOpen, onClose, onAuthorize }: { wallet: WalletInfo; workspaceId: string; isOpen: boolean; onClose: () => void; onAuthorize: () => void }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const chain = useChain()
  const operator = useOperator(workspaceId)
  const to = operator.data && isSetAddress(operator.data.operator) ? operator.data.operator : null
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Withdraw" subtitle={`${formatUsd(wallet.available)} available. ${to
      ? `Sent to the authorized wallet ${shortId(to)}, which must sign it.`
      : 'Withdrawals go to the authorized wallet, which must sign them.'}`}>
      <ChainGate chain={chain.data} error={chain.error}>
        {(info) => (
          <Suspense fallback={<LoadingRows rows={2} />}>
            <WalletFunding action="withdraw" workspaceId={workspaceId} wallet={wallet} chain={info} onAuthorize={() => { onClose(); onAuthorize() }} onDone={() => {
              toast('Withdrawal confirmed')
              void queryClient.invalidateQueries({ queryKey: qk.wallet(workspaceId) })
            }} />
          </Suspense>
        )}
      </ChainGate>
    </Modal>
  )
}

export default function Wallet() {
  const { workspace, viewer } = useConsole()
  const wallet = useWallet(workspace.id)
  const chain = useChain()
  const [dialog, setDialog] = useState<'fund' | 'withdraw' | null>(null)
  const [operatorAction, setOperatorAction] = useState<OperatorAction | null>(null)

  return (
    <div className="gc-page">
      <PageHeader title="Wallet & Funding" description={`Credits that pay for ${workspace.name}'s requests.`}
        actions={<Button leadingIcon={<Icon.plus size={14} />} onClick={() => setDialog('fund')}>Add funds</Button>} />
      <QueryView query={wallet} rows={2}>
        {(data) => (
          <>
            <StaleHint stale={data.stale} />
            <BalancePanel wallet={data} workspaceId={workspace.id} onWithdraw={() => setDialog('withdraw')} />
            <OperatorPanel workspaceId={workspace.id} action={operatorAction} onActionChange={setOperatorAction} />
            <Modal isOpen={dialog === 'fund'} onClose={() => setDialog(null)} size="md" title="Add funds" subtitle={`Credits that pay for ${workspace.name}'s requests.`}>
              <AddFunds wallet={data} chain={chain.data} workspaceId={workspace.id} />
            </Modal>
            <WithdrawModal wallet={data} workspaceId={workspace.id} isOpen={dialog === 'withdraw'} onClose={() => setDialog(null)} onAuthorize={() => setOperatorAction('authorize')} />
          </>
        )}
      </QueryView>
      <Channels workspaceId={workspace.id} canCooperate={isOrgAdmin(viewer)} onAuthorize={() => setOperatorAction('authorize')} />
    </div>
  )
}
