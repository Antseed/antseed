import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, Button, LoadingRows, Modal, useToast } from '@antseed/ui'
import { buildUsdcPaymentUri } from '@antseed/wallet-config'
import { api, errorMessage } from '../api'
import type { ChainInfo, DepositWatch, Wallet as WalletInfo } from '../api/types'
import { ChainGate } from '../components/ChainGate'
import { Icon } from '../components/icons'
import {
  AmexRoundMark, ApplePayRoundMark, ArbitrumMark, BaseMark, BnbMark, EthMark, GooglePayRoundMark, MastercardRoundMark, MeridianMark,
  PolygonMark, StripeMark, UsdcMark, VisaRoundMark,
} from '../components/payment-marks'
import { CopyButton } from '../components/ui'
import { useOpenChannels } from '../lib/attention'
import { contractAddress, explorerTxUrl } from '../lib/chain'
import { pendingSpend } from '../lib/channels'
import { useDepositWatchHeartbeat } from '../lib/deposit-watch'
import { useVisiblePolling } from '../lib/chain-polling'
import { formatUsd, shortId, usdcToNumber } from '../lib/format'
import { qk } from '../lib/queries'
import { StyledQr } from './StyledQr'

const WalletFunding = lazy(() => import('./WalletFunding'))

/** The desktop's presets: small first top-ups, any amount in the field. */
const AMOUNT_PRESETS = ['5', '10', '25']
/** Hosted provider for USDC from other chains; it credits the buyer address it is given. */
const MERIDIAN_URL = 'https://antseed.mrdn.finance/'

type Stage = 'choose' | 'crypto' | 'wallet'
type CardProvider = 'crossmint' | 'stripe'

/** Opens a tab synchronously (so the popup blocker treats it as the click), cut off from this page. */
function openBlankTab(): Window | null {
  const tab = window.open('about:blank', '_blank')
  if (tab) tab.opener = null
  return tab
}

interface StatusLine { tone: 'idle' | 'busy' | 'done' | 'error'; text: string }

/** The deposit watcher's latest event since the dialog opened, as the desktop words it. */
function statusLine(deposit: DepositWatch, baseline: number): StatusLine {
  if (deposit.mode === 'off') {
    return { tone: 'error', text: deposit.status === 'buyer-unreachable' ? 'The buyer is not reachable, so deposits are not watched right now.' : 'This wallet is not watched for deposits right now; USDC sent to it is credited once the buyer watches it again.' }
  }
  const event = deposit.event && deposit.event.seq > baseline ? deposit.event : null
  if (!event || event.phase === 'deferred') return { tone: 'idle', text: 'Waiting for USDC on Base…' }
  const amount = event.amount ? formatUsd(event.amount) : 'USDC'
  if (event.phase === 'received') return { tone: 'busy', text: `Received ${amount}, preparing the deposit…` }
  if (event.phase === 'sweeping') return { tone: 'busy', text: `Depositing ${amount} to the credits…` }
  if (event.phase === 'credited') return { tone: 'done', text: `${amount} added to the balance` }
  return { tone: 'error', text: event.error ?? 'The deposit failed. USDC stays in the workspace wallet and is retried.' }
}

function WatchStatus({ line }: { line: StatusLine }) {
  return (
    <div className={`gc-depwatch gc-depwatch--${line.tone}`} role="status">
      {line.tone === 'done' ? <Icon.check size={15} /> : <span className="gc-depwatch__dot" aria-hidden="true" />}
      {line.text}
    </div>
  )
}

function AmountPicker({ amount, setAmount, firstDeposit }: { amount: string; setAmount: (value: string) => void; firstDeposit: boolean }) {
  return (
    <div className="gc-fund-amount">
      <span className="gc-fund-amount__label">Amount to add</span>
      <div className="gc-fund-amount__row">
        {AMOUNT_PRESETS.map((preset) => (
          <button key={preset} type="button" className={amount === preset ? 'gc-preset gc-preset--on' : 'gc-preset'} aria-pressed={amount === preset} onClick={() => setAmount(preset)}>${preset}</button>
        ))}
        <label className="gc-fund-amount__input">
          <span aria-hidden="true">$</span>
          <input type="text" inputMode="decimal" value={amount} aria-label="Amount in USD" onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} />
        </label>
      </div>
      <span className="gc-fineprint">1 credit = 1 USDC{firstDeposit ? ' · The first deposit must be at least $1' : ''}</span>
    </div>
  )
}

function MethodRow({ icon, title, caption, badges, onClick, arrow }: { icon: React.ReactNode; title: string; caption: string; badges: React.ReactNode; onClick: () => void; arrow?: boolean }) {
  return (
    <button type="button" className="gc-method" onClick={onClick}>
      <span className="gc-method__icon">{icon}</span>
      <span className="gc-method__text"><span className="gc-method__title">{title}</span><span className="gc-method__caption">{caption}</span></span>
      <span className="gc-method__badges" aria-hidden="true">{badges}</span>
      {arrow ? <Icon.right size={16} className="gc-method__arrow" /> : <Icon.external size={14} className="gc-method__arrow" />}
    </button>
  )
}

/**
 * The Add funds dialog, laid out like the desktop's deposit view: a balance
 * summary, card checkout first (Crossmint), then USDC on Base by QR (the
 * deposit watcher moves it into the credits), with Meridian and the US-only
 * Stripe checkout behind "More options". Mounted only while the dialog is
 * open, so the deposit watcher runs fast only then.
 */
export function AddFunds({ wallet, chain, workspaceId }: { wallet: WalletInfo; chain: ChainInfo | undefined; workspaceId: string }) {
  const [stage, setStage] = useState<Stage>('choose')
  const [amount, setAmount] = useState('10')
  const [moreOpen, setMoreOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [opening, setOpening] = useState<CardProvider | null>(null)
  const queryClient = useQueryClient()
  const toast = useToast()
  const channels = useOpenChannels(workspaceId)
  useDepositWatchHeartbeat(workspaceId)
  // Only events after the dialog opened count; an old "credited" is not news.
  const baseline = useRef(wallet.deposit.event?.seq ?? 0)
  // The status line follows the watcher: every 4 s while USDC is on its way, every 8 s otherwise (visible tab only; the gateway answers from caches).
  const inFlight = wallet.deposit.event !== null && wallet.deposit.event.seq > baseline.current && (wallet.deposit.event.phase === 'received' || wallet.deposit.event.phase === 'sweeping')
  useVisiblePolling(qk.wallet(workspaceId), inFlight ? 4_000 : 8_000)
  // The embedded checkout, closed once its USDC is credited (the desktop closes its checkout popup the same way).
  const [checkout, setCheckout] = useState<{ url: string; provider: CardProvider } | null>(null)
  const event = wallet.deposit.event
  const credited = event && event.seq > baseline.current && event.phase === 'credited' ? event : null
  useEffect(() => {
    if (!credited) return
    toast(`${credited.amount ? formatUsd(credited.amount) : 'Your deposit'} added to the balance`)
    setCheckout(null)
    void queryClient.invalidateQueries({ queryKey: ['channels', workspaceId] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credited?.seq])

  const value = Number(amount)
  const amountOk = Number.isFinite(value) && value >= 1
  const total = usdcToNumber(wallet.available) + usdcToNumber(wallet.reserved)
  const owned = Math.max(0, total - (channels.data ? pendingSpend(channels.data) : 0)) + usdcToNumber(wallet.walletUsdc)
  const firstDeposit = total === 0
  const usdc = contractAddress(chain, 'usdc')
  const line = statusLine(wallet.deposit, baseline.current)
  const creditedUrl = credited?.txHash ? explorerTxUrl(chain, credited.txHash) : null

  /** Signs the funding link on the gateway and opens the pay page in the checkout dialog. */
  async function openCard(provider: CardProvider) {
    if (!amountOk) { setNotice('Enter an amount of at least $1.'); return }
    setOpening(provider)
    setNotice(null)
    try {
      const { url } = await api.wallet.cardLink(workspaceId, value, provider)
      if (!/^https:\/\//.test(url)) throw new Error('The gateway returned an invalid checkout link.')
      setCheckout({ url, provider })
    } catch (cause) {
      setNotice(errorMessage(cause))
    } finally {
      setOpening(null)
    }
  }

  function openMeridian() {
    const tab = openBlankTab()
    const url = `${MERIDIAN_URL}?buyer=${encodeURIComponent(wallet.address)}`
    if (tab) tab.location.replace(url)
    else window.location.href = url
  }

  const summary = (
    <div className="gc-fund-balance">
      <span className="gc-fund-balance__label">Workspace balance</span>
      <span className="gc-fund-balance__value">{formatUsd(owned)}</span>
      <span className="gc-fineprint">{formatUsd(wallet.available)} available · {formatUsd(wallet.reserved)} reserved{usdcToNumber(wallet.walletUsdc) > 0 ? ` · ${formatUsd(wallet.walletUsdc)} in the wallet` : ''}</span>
    </div>
  )

  if (stage === 'wallet') {
    return (
      <div className="gc-fund">
        <Button variant="link" size="sm" leadingIcon={<Icon.left size={14} />} onClick={() => setStage('crypto')}>Back</Button>
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
      </div>
    )
  }

  if (stage === 'crypto') {
    return (
      <div className="gc-fund">
        <Button variant="link" size="sm" leadingIcon={<Icon.left size={14} />} onClick={() => setStage('choose')}>All options</Button>
        <AmountPicker amount={amount} setAmount={setAmount} firstDeposit={firstDeposit} />
        <div className="gc-fund-pay">
          {usdc && chain
            ? <StyledQr text={buildUsdcPaymentUri({ usdcAddress: usdc, chainId: chain.chainId, address: wallet.address }, amountOk ? amount : '')} label={`Scan to send USDC on ${chain.name} to this workspace's wallet`} />
            : <div className="gc-qr gc-qr--placeholder" aria-hidden="true" />}
          <div className="gc-fund-pay__address">
            <code className="gc-mono" title={wallet.address}>{shortId(wallet.address)}</code>
            <CopyButton iconOnly value={wallet.address} label="Copy address" />
          </div>
          <WatchStatus line={line} />
          <span className="gc-fineprint">Credits update automatically · a small fixed relay fee is deducted</span>
          {creditedUrl && <a className="gc-link gc-fineprint" href={creditedUrl} target="_blank" rel="noopener noreferrer">View transaction</a>}
          <div className="gc-fund-pay__warn">Only send USDC on <strong>{chain?.name ?? 'Base'}</strong>. Other tokens or networks are not deposited.</div>
        </div>
        <Button variant="link" size="sm" trailingIcon={<Icon.right size={14} />} onClick={() => setStage('wallet')}>No wallet on your phone? Pay from a connected wallet instead</Button>
      </div>
    )
  }

  const checkoutDialog = (
    <Modal isOpen={checkout !== null} onClose={() => setCheckout(null)} size="md" title="Secure checkout"
      bodyClassName="gc-checkout"
      subtitle={checkout && (
        <>{checkout.provider === 'stripe' ? 'Card checkout by Stripe (US only).' : 'Card checkout by Crossmint.'} Closes by itself once the funds arrive.{' '}
          <a className="gc-link" href={checkout.url} target="_blank" rel="noopener noreferrer" onClick={() => setCheckout(null)}>Open in a new tab</a></>
      )}>
      {checkout && (
        <iframe className="gc-checkout__frame" src={checkout.url} title="Antseed Pay checkout"
          // Card wallets (Apple Pay, Google Pay) inside the page's own Crossmint/Stripe frames need the Payment Request API delegated.
          allow="payment *; clipboard-write" />
      )}
    </Modal>
  )

  return (
    <div className="gc-fund">
      {checkoutDialog}
      {summary}
      <AmountPicker amount={amount} setAmount={setAmount} firstDeposit={firstDeposit} />
      <button type="button" className="gc-method gc-method--primary" disabled={opening !== null} onClick={() => void openCard('crossmint')}>
        <span className="gc-method__text">
          <span className="gc-method__title">{opening === 'crossmint' ? 'Opening checkout…' : `Deposit${amountOk ? ` ${formatUsd(value)}` : ''} by card`}</span>
          <span className="gc-method__caption">Powered by Crossmint</span>
        </span>
        <span className="gc-method__badges" aria-hidden="true"><MastercardRoundMark /><ApplePayRoundMark /><GooglePayRoundMark /><VisaRoundMark /></span>
      </button>
      <div className="gc-fund-group">
        <MethodRow icon={<BaseMark size={22} />} title="Quick deposit" caption={`USDC on ${chain?.name ?? 'Base'}`} arrow onClick={() => setStage('crypto')}
          badges={<><UsdcMark /><span className="gc-fund-chip"><Icon.qr size={12} /></span></>} />
        <span className="gc-fineprint">* Deposited to the credits by the Antseed relayer network</span>
      </div>
      {notice && <Alert tone="danger">{notice}</Alert>}
      <button type="button" className="gc-fund-more" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
        More options <Icon.down size={16} className={moreOpen ? 'gc-fund-more__chevron gc-fund-more__chevron--open' : 'gc-fund-more__chevron'} />
      </button>
      {moreOpen && (
        <div className="gc-fund-options">
          <MethodRow icon={<MeridianMark />} title="Deposit using Meridian" caption="USDC from any chain" onClick={openMeridian}
            badges={<><EthMark /><ArbitrumMark /><BnbMark /><PolygonMark /></>} />
          <MethodRow icon={<StripeMark size={20} />} title={opening === 'stripe' ? 'Opening checkout…' : 'Deposit using Outerfound'} caption="Card · US only" onClick={() => void openCard('stripe')}
            badges={<><VisaRoundMark /><MastercardRoundMark /><AmexRoundMark /></>} />
        </div>
      )}
      <WatchStatus line={line} />
      <div className="gc-fund-trust">
        <span><Icon.lock size={12} /> Encrypted &amp; secure · Non-custodial escrow on {chain?.name ?? 'Base'}</span>
        <span><Icon.check size={12} /> Pay per request · No subscriptions, no lock-in</span>
      </div>
      <p className="gc-fineprint gc-fund-fine">Card checkout opens here and closes itself once the funds arrive. It is not available in every region.</p>
    </div>
  )
}
