import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { Alert, Button, DataTable, LoadingRows, Modal, Skeleton, TextField, useToast } from '@antseed/ui'
import { buildUsdcPaymentUri } from '@antseed/wallet-config'
import { api } from '../api'
import type { Channel, ChainInfo, Wallet as WalletInfo } from '../api/types'
import { useConsole } from '../app/context'
import { ChainGate } from '../components/ChainGate'
import { Icon } from '../components/icons'
import {
  Badge, ConfirmDialog, CopyButton, EmptyState, ErrorAlert, Figure, Mono, PageHeader, Panel, QueryView, SelectField, StaleHint, Switch, TabPanel, Tabs,
} from '../components/ui'
import { contractAddress, explorerTxUrl, isSetAddress } from '../lib/chain'
import { useDepositWatchHeartbeat } from '../lib/deposit-watch'
import { formatDateTime, formatUsd, shortId } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin } from '../lib/nav'
import { useVisiblePolling } from '../lib/chain-polling'
import { qk, useChain, useWallet } from '../lib/queries'
import { useOperator } from '../lib/operator'
import { OperatorPanel } from '../wallet/OperatorPanel'

const WalletFunding = lazy(() => import('../wallet/WalletFunding'))

const PRESETS = ['20', '50', '100']

function CardCheckout({ workspaceId }: { workspaceId: string }) {
  const [amount, setAmount] = useState('50')
  const [provider, setProvider] = useState<'crossmint' | 'stripe'>('crossmint')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const value = Number(amount)
  const valid = Number.isFinite(value) && value >= 1

  async function open() {
    // Open the tab synchronously so the popup blocker treats it as a click, cut its link back
    // to this page before anything loads in it (no reverse tabnabbing), then point it at the checkout.
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    setBusy(true)
    setError(null)
    try {
      const { url } = await api.wallet.cardLink(workspaceId, value, provider)
      if (!/^https:\/\//.test(url)) throw new Error('The gateway returned an invalid checkout link.')
      if (tab) {
        tab.location.replace(url)
      } else {
        window.location.href = url
      }
    } catch (cause) {
      tab?.close()
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gc-stack">
      <p className="gc-muted">Pay by card. Funds arrive as USDC credits in this workspace.</p>
      <div className="gc-inline gc-inline--wrap">
        {PRESETS.map((preset) => (
          <Button key={preset} variant={amount === preset ? 'primary' : 'outline'} size="sm" onClick={() => setAmount(preset)}>${preset}</Button>
        ))}
        <TextField aria-label="Amount in USD" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className="gc-amount" />
      </div>
      <SelectField label="Checkout provider" value={provider} onChange={(next) => setProvider(next as 'crossmint' | 'stripe')}
        options={[{ value: 'crossmint', label: 'Crossmint' }, { value: 'stripe', label: 'Stripe' }]}
        hint="Card checkout is not available in every region." />
      {error ? <ErrorAlert error={error} title="Could not start checkout" /> : null}
      <Button disabled={!valid || busy} onClick={() => void open()} trailingIcon={<Icon.external size={14} />}>
        {busy ? 'Opening…' : `Pay ${valid ? formatUsd(value) : ''} by card`}
      </Button>
      <p className="gc-fineprint">Checkout opens in a new tab. This page updates when the funds arrive.</p>
    </div>
  )
}

function SendUsdc({ wallet, chain }: { wallet: WalletInfo; chain: ChainInfo | undefined }) {
  const [amount, setAmount] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const usdc = contractAddress(chain, 'usdc')
  const uri = usdc && chain ? buildUsdcPaymentUri({ usdcAddress: usdc, chainId: chain.chainId, address: wallet.address }, amount) : null
  useEffect(() => {
    let cancelled = false
    if (!uri) { setQr(null); return }
    void QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then((url) => { if (!cancelled) setQr(url) })
    return () => { cancelled = true }
  }, [uri])
  return (
    <div className="gc-send">
      <div className="gc-send__qr">
        {qr ? <img src={qr} width={220} height={220} alt="QR code for a USDC payment to this workspace's wallet" /> : <Skeleton width={220} height={220} />}
      </div>
      <div className="gc-stack">
        <p className="gc-muted">Send USDC on {chain?.name ?? 'Base'} from an exchange or any wallet. Scan with a mobile wallet or copy the address.</p>
        <div className="gc-address">
          <Mono>{wallet.address}</Mono>
          <CopyButton value={wallet.address} label="Copy address" />
        </div>
        <TextField label="Amount for the QR code (optional)" inputMode="decimal" placeholder="Any amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
        <Alert tone="warning">Only send USDC on {chain?.name ?? 'Base'}. Other tokens or networks are lost.</Alert>
        <p className="gc-fineprint">USDC that lands in the wallet is moved into your credits automatically.</p>
      </div>
    </div>
  )
}

/**
 * Re-reads the balance every 30 s while the Add funds dialog is open and the
 * tab visible (chain-backed: the gateway serves it from a cache that a
 * public RPC has to refill). A credited deposit shows up through the
 * deposit watcher's status in the same response.
 */
function useBalancePolling(workspaceId: string) {
  useVisiblePolling(qk.wallet(workspaceId))
}

type FundTab = 'card' | 'send' | 'wallet'

/** The Add funds dialog body: mounted only while the dialog is open, so the deposit watcher runs fast only then. */
function AddFunds({ wallet, chain, workspaceId }: { wallet: WalletInfo; chain: ChainInfo | undefined; workspaceId: string }) {
  const [tab, setTab] = useState<FundTab>('card')
  const queryClient = useQueryClient()
  const toast = useToast()
  useDepositWatchHeartbeat(workspaceId)
  useBalancePolling(workspaceId)
  const lastDepositUrl = wallet.deposit.lastTxHash ? explorerTxUrl(chain, wallet.deposit.lastTxHash) : null
  return (
      <div className="gc-stack">
        <Tabs id="gc-fund" label="Ways to add funds" value={tab} onChange={setTab} tabs={[{ id: 'card', label: 'Card' }, { id: 'send', label: 'Send USDC' }, { id: 'wallet', label: 'Pay from a wallet' }]} />
        <TabPanel tabsId="gc-fund" tab={tab}>
        {tab === 'card' && <CardCheckout workspaceId={workspaceId} />}
        {tab === 'send' && <SendUsdc wallet={wallet} chain={chain} />}
        {tab === 'wallet' && (
          <ChainGate chain={chain}>
            {(info) => (
              <Suspense fallback={<LoadingRows rows={2} />}>
                <WalletFunding action="deposit" workspaceId={workspaceId} wallet={wallet} chain={info} onDone={() => {
                  toast('Deposit confirmed')
                  void queryClient.invalidateQueries({ queryKey: qk.wallet(workspaceId) })
                }} />
              </Suspense>
            )}
          </ChainGate>
        )}
        </TabPanel>
        <div className="gc-watch">
          <span className="gc-pulse" aria-hidden="true" /> Watching for deposits: {wallet.deposit.status || 'waiting'}
          {lastDepositUrl && (
            <> · <a className="gc-link" href={lastDepositUrl} target="_blank" rel="noopener noreferrer">last deposit</a></>
          )}
        </div>
      </div>
  )
}

function Channels({ workspaceId, canClose }: { workspaceId: string; canClose: boolean }) {
  const [all, setAll] = useState(false)
  const [closing, setClosing] = useState<Channel | null>(null)
  const channels = useQuery({ queryKey: qk.channels(workspaceId, all), queryFn: () => api.wallet.channels(workspaceId, all) })
  const close = useConsoleMutation({
    mutationFn: (channel: Channel) => api.wallet.closeChannel(workspaceId, channel.peerId),
    onSuccess: () => setClosing(null),
    invalidate: [['channels', workspaceId], qk.wallet(workspaceId)],
  })
  return (
    <Panel flush title="Payment channels" description="Funds reserved with sellers. Closing a channel returns what was not spent."
      actions={<Switch checked={all} onChange={setAll} label="Include closed" />}>
      <QueryView query={channels}>
        {(rows) => (
          <DataTable<Channel> label="Payment channels" rows={rows} rowKey={(channel) => channel.channelId}
            rowLabel={(channel) => `channel with ${channel.sellerName ?? shortId(channel.peerId)}`}
            actions={(channel) => [canClose && channel.canCooperativeClose && { label: 'Close channel', onSelect: () => setClosing(channel) }]}
            empty={<EmptyState icon={<Icon.wallet size={18} />} title="No open channels" body="A channel opens the first time a seller serves this workspace." />}
            columns={[
              { key: 'seller', header: 'Seller', render: (channel) => channel.sellerName ?? <Mono title={channel.peerId}>{shortId(channel.peerId)}</Mono> },
              { key: 'status', header: 'Status', render: (channel) => <Badge tone={channel.status === 'active' || channel.status === 'open' ? 'success' : 'neutral'}>{channel.status}</Badge> },
              { key: 'reserved', header: 'Reserved', align: 'right', render: (channel) => formatUsd(channel.reserved) },
              { key: 'spent', header: 'Spent', align: 'right', render: (channel) => formatUsd(channel.spent) },
              { key: 'opened', header: 'Opened', secondary: true, render: (channel) => formatDateTime(channel.openedAt) },
            ]} />
        )}
      </QueryView>
      <ConfirmDialog isOpen={closing !== null} busy={close.isPending} error={close.error} onClose={() => { setClosing(null); close.reset() }}
        onConfirm={() => closing && close.mutate(closing)} title="Close this channel?" confirmLabel="Close channel" tone="primary"
        body="The seller settles what was spent and the rest returns to your available balance. A new channel opens if this seller is used again." />
    </Panel>
  )
}

function BalancePanel({ wallet, onWithdraw }: { wallet: WalletInfo; onWithdraw: () => void }) {
  return (
    <Panel title="Balance" actions={<Button size="sm" variant="outline" onClick={onWithdraw}>Withdraw</Button>}>
      <div className="gc-grid gc-grid--4 gc-figures">
        <Figure label="Available" value={formatUsd(wallet.available)} strong />
        <Figure label="Reserved in channels" value={formatUsd(wallet.reserved)} />
        <Figure label="In wallet, not deposited" value={formatUsd(wallet.walletUsdc)} />
        <Figure label="Credit limit" value={wallet.creditLimit === null ? 'None' : formatUsd(wallet.creditLimit)} />
      </div>
      <p className="gc-fineprint gc-wallet-meta">
        Workspace wallet <Mono title={wallet.address}>{shortId(wallet.address)}</Mono> <CopyButton iconOnly value={wallet.address} label="Copy address" />
        <span aria-hidden="true">·</span> Withdrawals go to the authorized wallet below.
      </p>
    </Panel>
  )
}

/** Withdrawals are signed by, and paid to, the authorized wallet; the dialog says so and gates on it. */
function WithdrawModal({ wallet, workspaceId, isOpen, onClose }: { wallet: WalletInfo; workspaceId: string; isOpen: boolean; onClose: () => void }) {
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
            <WalletFunding action="withdraw" workspaceId={workspaceId} wallet={wallet} chain={info} onDone={() => {
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

  return (
    <div className="gc-page">
      <PageHeader title="Wallet & Funding" description={`Credits that pay for ${workspace.name}'s requests.`}
        actions={<Button leadingIcon={<Icon.plus size={14} />} onClick={() => setDialog('fund')}>Add funds</Button>} />
      <QueryView query={wallet} rows={2}>
        {(data) => (
          <>
            <StaleHint stale={data.stale} />
            <BalancePanel wallet={data} onWithdraw={() => setDialog('withdraw')} />
            <OperatorPanel workspaceId={workspace.id} />
            <Modal isOpen={dialog === 'fund'} onClose={() => setDialog(null)} size="lg" title="Add funds" subtitle={`Credits for ${workspace.name}. ${formatUsd(data.available)} available now.`}>
              <AddFunds wallet={data} chain={chain.data} workspaceId={workspace.id} />
            </Modal>
            <WithdrawModal wallet={data} workspaceId={workspace.id} isOpen={dialog === 'withdraw'} onClose={() => setDialog(null)} />
          </>
        )}
      </QueryView>
      <Channels workspaceId={workspace.id} canClose={isOrgAdmin(viewer)} />
    </div>
  )
}
