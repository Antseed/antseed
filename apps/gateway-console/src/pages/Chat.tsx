import '../chat/chat.css'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import { CheckCircle2Icon, CheckIcon, ChevronsUpDownIcon, LockIcon, MessageSquarePlusIcon, MessagesSquareIcon, ShuffleIcon, Trash2Icon } from 'lucide-react'
import { Drawer } from '@antseed/ui'
import { API_BASE, CSRF_HEADER, api } from '../api'
import type { ChatMessageMetadata, ChatModel, ChatModelPeer, ChatThread, RoutePreview } from '../api/types'
import {
  autoPick, isFreeOffer, MODEL_FILTERS, MODEL_SORTS, PEER_FILTERS, PEER_SORTS, pickModels, pickPeers, verdictsFrom,
  type ModelFilter, type ModelSort, type PeerFilter, type PeerSort,
} from '../lib/chat-pick'
import { useConsole } from '../app/context'
import { isOrgAdmin, isWorkspaceAdmin } from '../lib/nav'
import { qk, useWallet } from '../lib/queries'
import { useConsoleMutation } from '../lib/mutations'
import { formatRelative, formatTokens, formatUsd, shortId } from '../lib/format'
import { href, linkHandler } from '../lib/router'
import { Button } from '@/chat/components/ui/button'
import { cn } from '@/chat/lib/utils'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/chat/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/chat/components/ai-elements/message'
import { loadMarkdown } from '@/chat/components/ai-elements/markdown'
import {
  ModelSelector, ModelSelectorContent, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorInput, ModelSelectorItem, ModelSelectorList, ModelSelectorName, ModelSelectorTrigger,
} from '@/chat/components/ai-elements/model-selector'
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools, type PromptInputMessage } from '@/chat/components/ai-elements/prompt-input'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/chat/components/ai-elements/reasoning'
import { Shimmer } from '@/chat/components/ai-elements/shimmer'
import { Suggestion } from '@/chat/components/ai-elements/suggestion'
import { Spinner } from '@/chat/components/ui/spinner'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from '@/chat/components/ai-elements/tool'

type ChatMessage = UIMessage<ChatMessageMetadata>

const STORE_PREFIX = 'antseed-console-chat'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${STORE_PREFIX}:${key}`)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}
function save(key: string, value: unknown): void {
  try { localStorage.setItem(`${STORE_PREFIX}:${key}`, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

function newChatId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function price(value: number | null): string {
  return value === null ? '?' : `$${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}`
}

/** An estimated cost: "≈ $0.0021", or "cost unknown" when a serving peer's price was not advertised. */
function estimate(cost: number | null | undefined): string {
  if (cost === null) return 'cost unknown'
  return `≈ ${formatUsd(cost ?? 0)}`
}

const PHONE = '(max-width: 640px)'

/**
 * Sizes the chat to the window below its own top edge (banners above it vary),
 * so the composer stays on screen and only the conversation scrolls.
 *
 * Phones lay the page out in CSS instead (see `.gc-app[data-page="chat"]`): the app is pinned to the
 * visible viewport, which this keeps in `--gc-vvh`/`--gc-vvtop` so the composer stays above the
 * on-screen keyboard and the browser's toolbars, like a messaging app.
 */
function useFillViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const root = document.documentElement
    const phone = window.matchMedia(PHONE)
    const viewport = window.visualViewport
    const fit = () => {
      if (phone.matches) {
        if (element.style.height) element.style.height = ''
        if (viewport) {
          root.style.setProperty('--gc-vvh', `${viewport.height}px`)
          root.style.setProperty('--gc-vvtop', `${viewport.offsetTop}px`)
        }
        return
      }
      const top = element.getBoundingClientRect().top + window.scrollY
      // The page's bottom padding must fit too. Measured from the padding, not the document: the main area
      // stretches to the window, so the document's height would count the gap this chat leaves and keep it.
      const main = element.closest('main')
      const below = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0
      const height = `${Math.max(448, window.innerHeight - top - below)}px`
      if (element.style.height !== height) element.style.height = height
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(document.body)
    window.addEventListener('resize', fit)
    phone.addEventListener('change', fit)
    viewport?.addEventListener('resize', fit)
    viewport?.addEventListener('scroll', fit)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
      phone.removeEventListener('change', fit)
      viewport?.removeEventListener('resize', fit)
      viewport?.removeEventListener('scroll', fit)
      root.style.removeProperty('--gc-vvh')
      root.style.removeProperty('--gc-vvtop')
    }
  }, [])
  return ref
}

function peerLabel(peer: { peerId: string; name: string | null }): string {
  return peer.name ? `${peer.name} (${shortId(peer.peerId)})` : shortId(peer.peerId)
}

/** A seller's name, or its short id when it has none (the full id is in the hover card). */
function peerName(peer: { peerId: string; name: string | null }): string {
  return peer.name ?? shortId(peer.peerId)
}

/** A small label: green for free, blue for TEE, outlined grey otherwise. */
function Pill({ tone = 'neutral', children, title }: { tone?: 'free' | 'tee' | 'neutral'; children: ReactNode; title?: string }) {
  const tones = {
    free: 'border-success/30 bg-success/10 text-success',
    tee: 'border-info/30 bg-info/10 text-info',
    neutral: 'border-border text-muted-foreground',
  }
  return <span title={title} className={`inline-flex items-center rounded border px-1.5 py-px font-medium text-[10px] leading-4 ${tones[tone]}`}>{children}</span>
}

/** A stable colour per seller, so the same seller always looks the same across answers. */
function peerColor(peerId: string): string {
  let hash = 0
  for (const char of peerId) hash = (hash * 31 + char.charCodeAt(0)) % 300
  // Hues 30–329 only: red reads as an error.
  return `hsl(${30 + hash} 65% 55%)`
}

/** A price, or the green Free label. */
function PriceTag({ offer }: { offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null } }) {
  return isFreeOffer(offer) ? <Pill tone="free">Free</Pill> : <span className="text-muted-foreground text-xs">{priceRange(offer)}</span>
}

/** Who wrote a message: "You", or the seller(s) that answered with the model. */
/**
 * While a turn runs, whether nothing on screen is moving: before the answer's first part, or between
 * steps (a tool call finished, or a text or reasoning part ended, and the model is working on the next).
 */
function isWaitingForModel(message: ChatMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return true
  const last = message.parts.filter((part) => part.type !== 'step-start').at(-1)
  if (!last) return true
  if (last.type === 'text' || last.type === 'reasoning') return last.state !== 'streaming'
  if (last.type === 'dynamic-tool' || last.type.startsWith('tool-')) {
    const { state } = last as ToolPart
    return state === 'output-available' || state === 'output-error' || state === 'output-denied'
  }
  return false
}

/** Details shown while the pointer (or keyboard focus) is on `children`: prices, routing reasons, tokens. */
function HoverCard({ children, card, side = 'top' }: { children: ReactNode; card: ReactNode; side?: 'top' | 'bottom' }) {
  // Opens upward unless there is no room above (the first answer, at the top of the scrolling chat).
  const [placement, setPlacement] = useState(side)
  const place = (event: { currentTarget: HTMLElement }) => {
    if (side !== 'top') return
    const scroller = event.currentTarget.closest('.gc-chat-conversation') ?? document.documentElement
    const room = event.currentTarget.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    setPlacement(room < 160 ? 'bottom' : 'top')
  }
  return (
    <span className="group/hover relative inline-flex min-w-0 shrink" onMouseEnter={place} onFocus={place}>
      {children}
      <span role="tooltip" className={cn(
        'pointer-events-none invisible absolute left-0 z-30 w-max max-w-80 rounded-lg border bg-popover p-3 text-left font-normal text-popover-foreground text-xs leading-5 opacity-0 shadow-md transition-opacity',
        'group-focus-within/hover:visible group-focus-within/hover:opacity-100 group-hover/hover:visible group-hover/hover:opacity-100',
        placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
      )}>{card}</span>
    </span>
  )
}

/** "$0.09 in · $0.38 out per 1M", or Free. */
function offerPrices(offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null }): string {
  if (isFreeOffer(offer)) return 'Free'
  return `${price(offer.inputUsdPerMillion)} in · ${price(offer.outputUsdPerMillion)} out per 1M`
}

/** Why automatic routing ranks sellers the way it does: its sort, the trust floor, and a cheaper seller it skips. */
function autoReason(preview: RoutePreview | undefined, model: ChatModel | null): string {
  if (!preview) return 'Auto picks the best seller that passes your routing settings.'
  const buyer = preview.sources.find((source) => source.level === 'buyer')?.policy ?? null
  const sort = preview.policy.sort ?? buyer?.sort ?? 'balanced'
  const floor = Math.max(preview.policy.minTrustScore ?? 0, buyer?.minTrustScore ?? 0)
  const how = {
    price: 'Auto: cheapest seller',
    latency: 'Auto: fastest seller',
    trust: 'Auto: most trusted seller',
    balanced: 'Auto: best mix of price, trust and speed',
  }[sort]
  let reason = `${how}${floor > 0 ? ` with trust ${floor}+` : ''}.`
  const pick = autoPick(preview)
  const cheaper = preview.candidates
    .filter((candidate) => !candidate.eligible && candidate.inputUsdPerMillion !== null && pick?.inputUsdPerMillion != null && candidate.inputUsdPerMillion < pick.inputUsdPerMillion)
    .sort((a, b) => (a.inputUsdPerMillion ?? 0) - (b.inputUsdPerMillion ?? 0))[0]
  if (cheaper) {
    const name = model?.peers.find((peer) => peer.peerId === cheaper.peerId.toLowerCase())?.name ?? cheaper.displayName ?? shortId(cheaper.peerId)
    reason += ` Cheaper ${name} is skipped: ${cheaper.reasons[0] ?? 'not eligible'}.`
  }
  return reason
}

/**
 * One quiet line under an answer: who served it, their trust, what it cost, and (on the latest answer)
 * Pin and Try another seller. Prices and tokens are in the hover card.
 */
function AnswerLine({ message, streaming, model, preview, actions }: {
  message: ChatMessage
  streaming: boolean
  model: ChatModel | null
  preview: RoutePreview | undefined
  actions: { pinned: boolean; onPin: () => void; onTryAnother: (() => void) | null } | null
}) {
  const metadata = message.metadata
  if (!metadata) return null
  const peers = metadata.peers
  if (peers.length === 0) {
    if (streaming) return null
    return <div className="text-muted-foreground text-xs">No seller answered</div>
  }
  const served = peers[peers.length - 1]!
  const offer = model?.peers.find((peer) => peer.peerId === served.peerId)
  const trust = preview?.candidates.find((candidate) => candidate.peerId.toLowerCase() === served.peerId)?.trustScore ?? null
  const usage = metadata.usage
  const names = [...new Set(peers.map(peerName))].join(' → ')
  const card = (
    <>
      <span className="block font-medium text-sm">{model?.name ?? metadata.model} via {names}</span>
      {offer && <span className="block font-mono">{offerPrices(offer)}</span>}
      {usage && <span className="block text-muted-foreground">{formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out tokens</span>}
      <span className="block text-muted-foreground">{metadata.pinnedPeerId ? 'Pinned seller.' : autoReason(preview, model)}</span>
      <span className="block font-mono text-muted-foreground">{served.peerId}</span>
    </>
  )
  const link = 'font-medium text-foreground underline underline-offset-2 hover:no-underline'
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs" aria-live="polite">
      {streaming ? <Spinner className="size-3.5" /> : <CheckCircle2Icon className="size-3.5" />}
      <HoverCard card={card}>
        <span tabIndex={0} className="cursor-default text-foreground outline-none">{names}</span>
      </HoverCard>
      {trust !== null && <span>· trust {Math.round(trust)}</span>}
      <span>·</span>
      {metadata.costUsd === 0 ? <Pill tone="free">Free</Pill> : <span className="text-foreground" title="At the serving seller's advertised prices; the signed amount is in Logs.">{estimate(metadata.costUsd)}</span>}
      {metadata.pinnedPeerId && <span>· pinned</span>}
      {actions && !actions.pinned && <button type="button" className={cn('ml-1', link)} onClick={actions.onPin}>Pin</button>}
      {actions?.onTryAnother && <button type="button" className={cn(actions.pinned ? 'ml-1' : '', link)} onClick={actions.onTryAnother}>Try another seller</button>}
    </div>
  )
}

/** The chat's tool switches, remembered on this browser. Shell is for organization admins and starts off. */
interface ToolSwitches { web: boolean; files: boolean; shell: boolean }

function ToolSwitch({ label, on, onChange, title, icon }: { label: string; on: boolean; onChange: (on: boolean) => void; title: string; icon?: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} title={title} onClick={() => onChange(!on)}
      className={cn('inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors',
        on ? 'border-foreground/20 bg-muted text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60')}>
      {on ? <CheckIcon className="size-3" /> : icon}
      {label}
    </button>
  )
}

/** Toggle chips for the picker filters, plus a sort choice; remembered on this browser. */
function FilterBar<F extends string, S extends string>({ filters, active, onToggle, sorts, sort, onSort, count }: {
  filters: Array<{ id: F; label: string }>
  active: ReadonlySet<F>
  onToggle: (id: F) => void
  sorts: Array<{ id: S; label: string }>
  sort: S
  onSort: (id: S) => void
  count: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
      {filters.map((filter) => (
        <Button key={filter.id} type="button" size="xs" variant={active.has(filter.id) ? 'secondary' : 'ghost'} aria-pressed={active.has(filter.id)}
          className={active.has(filter.id) ? 'border border-foreground/30' : 'border border-transparent text-muted-foreground'} onClick={() => onToggle(filter.id)}>
          {active.has(filter.id) && <CheckIcon />}{filter.label}
        </Button>
      ))}
      <span className="ml-auto text-muted-foreground text-xs">{count}</span>
      <label className="flex items-center gap-1 text-muted-foreground text-xs">
        Sort
        <select className="rounded-md border bg-transparent px-1.5 py-0.5 text-foreground text-xs" value={sort} onChange={(event) => onSort(event.target.value as S)}>
          {sorts.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
    </div>
  )
}

/** Small capability tags after a name. */
function Tags({ free, tools, reasoning, vision, tee }: { free?: boolean; tools?: boolean; reasoning?: boolean; vision?: boolean; tee?: boolean }) {
  return (
    <span className="flex flex-wrap gap-1">
      {free && <Pill tone="free">Free</Pill>}
      {tee && <Pill tone="tee">TEE</Pill>}
      {tools && <Pill>Tools</Pill>}
      {reasoning && <Pill>Reasoning</Pill>}
      {vision && <Pill>Vision</Pill>}
    </span>
  )
}

/** A stored set of filter ids for one picker. */
function useStoredSet<T extends string>(key: string) {
  const [value, setValue] = useState<Set<T>>(() => new Set(load<T[]>(key, [])))
  const toggle = (id: T) => setValue((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    save(key, [...next])
    return next
  })
  return [value, toggle] as const
}

function useStored<T extends string>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => load<T>(key, fallback))
  return [value, (next: T) => { setValue(next); save(key, next) }] as const
}

function priceRange(offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null }): string {
  if (isFreeOffer(offer)) return 'Free'
  return `${price(offer.inputUsdPerMillion)} / ${price(offer.outputUsdPerMillion)} per M`
}

function ModelPicker({ models, value, onChange, className }: { models: ChatModel[]; value: ChatModel | null; onChange: (id: string) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const [filters, toggle] = useStoredSet<ModelFilter>('model-filters')
  const [sort, setSort] = useStored<ModelSort>('model-sort', 'popular')
  const shown = pickModels(models, filters, sort)
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button variant="ghost" size="sm" className={cn('min-w-0 max-w-80 shrink justify-between gap-1 px-2 font-semibold', className)}
          title={value ? `${value.offers} seller${value.offers === 1 ? '' : 's'}, ${value.free ? 'free offers' : `from ${priceRange(value)}`}` : undefined}>
          <span className="truncate">{value ? value.name : 'Pick a model'}</span>
          {value?.free && <Pill tone="free">Free</Pill>}
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Model" className="sm:max-w-2xl">
        <ModelSelectorInput placeholder="Search models…" />
        <FilterBar filters={MODEL_FILTERS} active={filters} onToggle={toggle} sorts={MODEL_SORTS} sort={sort} onSort={setSort}
          count={`${shown.length} of ${models.length} models`} />
        <ModelSelectorList className="max-h-[min(28rem,60vh)]">
          <ModelSelectorEmpty>No model matches.{filters.size > 0 ? ' Try fewer filters.' : ''}</ModelSelectorEmpty>
          <ModelSelectorGroup>
            {shown.map((model) => (
              <ModelSelectorItem key={model.id} value={`${model.name} ${model.id}`} onSelect={() => { onChange(model.id); setOpen(false) }} className="items-start py-2">
                <span className="flex min-w-0 flex-col gap-1">
                  <ModelSelectorName>{model.name}</ModelSelectorName>
                  <Tags free={model.free} tools={model.toolUse} reasoning={model.reasoning} vision={model.vision} tee={model.tee} />
                </span>
                <span className="ml-auto shrink-0 text-right text-muted-foreground text-xs">
                  {model.offers} seller{model.offers === 1 ? '' : 's'}
                  <span className="mt-0.5 block">{model.free ? <Pill tone="free">Free offers</Pill> : `from ${priceRange(model)}`}</span>
                </span>
                {value?.id === model.id && <CheckIcon className="size-3.5 shrink-0" />}
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}

/** What automatic routing would do right now: its first seller, or why none. */
/** Amber dot + one line, for something the user should act on. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="size-2 shrink-0 translate-y-[-1px] rounded-full bg-amber-500" aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}

/** Same model under another spelling ("glm-5.3-flash" vs "glm-5-3-flash"): the network list can re-key a model. */
const modelKey = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, '')

function autoSummary(pick: ReturnType<typeof autoPick>, model: ChatModel | null, loading: boolean, unfunded: boolean): ReactNode {
  if (loading) return 'Checking which seller automatic routing picks…'
  if (!pick) return 'No seller passes your routing settings for this model right now.'
  const peer = model?.peers.find((entry) => entry.peerId === pick.peerId.toLowerCase())
  const name = peer ? peerLabel(peer) : peerLabel({ peerId: pick.peerId, name: pick.displayName })
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
      Right now:
      <span className="size-2 rounded-full" style={{ background: peerColor(pick.peerId.toLowerCase()) }} aria-hidden="true" />
      <span className="font-medium text-foreground">{name}</span>
      <PriceTag offer={pick} />
      {pick.trustScore !== null && <span>trust {Math.round(pick.trustScore)}</span>}
      {unfunded && !isFreeOffer(pick) && (
        <Notice>
          No free seller offers {model?.name ?? 'this model'} right now, and the wallet has no funds for a paid one.{' '}
          <a className="font-medium text-foreground underline underline-offset-2" href={href('wallet')} onClick={linkHandler('wallet')}>Add funds</a>
        </Notice>
      )}
    </span>
  )
}

function PeerPicker({ model, value, onChange, preview, previewLoading, unfunded, className, compact = false }: {
  model: ChatModel | null
  className?: string
  /** The phone layout: a quiet chip in the composer, without the price. */
  compact?: boolean
  value: string | null
  onChange: (peerId: string | null) => void
  preview: RoutePreview | undefined
  previewLoading: boolean
  unfunded: boolean
}) {
  const [open, setOpen] = useState(false)
  const [filters, toggle] = useStoredSet<PeerFilter>('peer-filters')
  const [sort, setSort] = useStored<PeerSort>('peer-sort', 'auto')
  const pinned = model?.peers.find((peer) => peer.peerId === value) ?? null
  const verdicts = verdictsFrom(preview)
  const pick = autoPick(preview)
  const pickedPeer = pick ? model?.peers.find((peer) => peer.peerId === pick.peerId.toLowerCase()) ?? null : null
  const all = model?.peers ?? []
  const shown = pickPeers(all, filters, sort, verdicts)
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <HoverCard side="bottom" card={(
        <>
          {(pinned ?? pickedPeer) && <span className="block font-medium text-sm">{model?.name} via {peerName((pinned ?? pickedPeer)!)}</span>}
          {(pinned ?? pickedPeer) && <span className="block font-mono">{offerPrices((pinned ?? pickedPeer)!)}</span>}
          <span className="block text-muted-foreground">{pinned ? 'Pinned: every turn goes to this seller.' : autoReason(preview, model)}</span>
        </>
      )}>
      <ModelSelectorTrigger asChild>
        <Button variant="ghost" size="sm" className={cn('min-w-0 max-w-96 shrink justify-between gap-1.5 px-2 text-muted-foreground', className)} disabled={!model}>
          {pinned ? <span className="size-2 rounded-full" style={{ background: peerColor(pinned.peerId) }} aria-hidden="true" /> : <ShuffleIcon className="size-3.5" />}
          <span className="truncate">
            {pinned ? peerName(pinned) : <>Auto{pickedPeer && !compact ? <span className="max-sm:hidden"> · {peerName(pickedPeer)}</span> : ''}</>}
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </ModelSelectorTrigger>
      </HoverCard>
      <ModelSelectorContent title="Seller" className="sm:max-w-2xl">
        <ModelSelectorInput placeholder="Search sellers…" />
        <FilterBar filters={PEER_FILTERS} active={filters} onToggle={toggle} sorts={PEER_SORTS} sort={sort} onSort={setSort}
          count={`${shown.length} of ${all.length} sellers`} />
        <ModelSelectorList className="max-h-[min(30rem,60vh)]">
          <ModelSelectorEmpty>No seller matches.{filters.size > 0 ? ' Try fewer filters.' : ''}</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Routing">
            <ModelSelectorItem value="auto automatic best offer routing" onSelect={() => { onChange(null); setOpen(false) }} className="items-start py-2">
              <ShuffleIcon className="mt-0.5 size-3.5" />
              <span className="flex min-w-0 flex-col">
                <ModelSelectorName>Auto: the gateway picks the best offer each turn</ModelSelectorName>
                <span className="text-muted-foreground text-xs">{autoSummary(pick, model, previewLoading, unfunded)}</span>
              </span>
              {value === null && <CheckIcon className="ml-auto size-3.5" />}
            </ModelSelectorItem>
          </ModelSelectorGroup>
          <ModelSelectorGroup heading={`Sellers offering ${model?.name ?? 'this model'}`}>
            {shown.map((peer: ChatModelPeer) => {
              const verdict = verdicts.get(peer.peerId)
              const skipped = verdict !== undefined && !verdict.eligible
              return (
                <ModelSelectorItem key={peer.peerId} value={`${peer.name ?? ''} ${peer.peerId}`} onSelect={() => { onChange(peer.peerId); setOpen(false) }} className="items-start py-2">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: peerColor(peer.peerId) }} aria-hidden="true" />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className={`flex items-center gap-2 ${skipped ? 'text-muted-foreground' : ''}`}>
                      <ModelSelectorName>{peerLabel(peer)}</ModelSelectorName>
                      {verdict?.eligible && verdict.rank !== null && <span className="text-muted-foreground text-xs">#{verdict.rank}</span>}
                    </span>
                    <Tags free={isFreeOffer(peer)} tools={peer.toolUse} reasoning={peer.reasoning} vision={peer.vision} tee={peer.tee} />
                    {skipped && <span className="text-muted-foreground text-xs">Auto skips it: {verdict.reasons[0] ?? 'not eligible'}. You can still pin it.</span>}
                    {!peer.toolUse && <span className="text-muted-foreground text-xs">No tools: plain chat when pinned.</span>}
                  </span>
                  <span className="ml-auto flex shrink-0 flex-col items-end gap-0.5 text-muted-foreground text-xs">
                    <PriceTag offer={peer} />
                    {peer.reputation !== null && <span>trust {Math.round(peer.reputation)}</span>}
                  </span>
                  {value === peer.peerId && <CheckIcon className="size-3.5 shrink-0" />}
                </ModelSelectorItem>
              )
            })}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}

/**
 * A tool call waiting for the user (the shell, for org admins): the exact
 * command, with Approve and Deny. Nothing runs until Approve; the gateway
 * runs the call it stored, not whatever the page sends back.
 */
function ToolApproval({ part, onAnswer }: { part: ToolPart; onAnswer: ((approved: boolean) => void) | null }) {
  const input = part.input as { command?: unknown } | undefined
  const command = typeof input?.command === 'string' ? input.command : JSON.stringify(part.input, null, 2)
  return (
    <div className="space-y-2 border-t p-3">
      <p className="font-medium text-sm">Run this command on the gateway host?</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs">{command}</pre>
      <p className="text-muted-foreground text-xs">
        It runs as the gateway's user, with access to its files. The model chose it, and a seller or a page it read can steer the model: approve only a command you understand.
      </p>
      {onAnswer
        ? (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => onAnswer(true)}>Approve</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => onAnswer(false)}>Deny</Button>
          </div>
        )
        : <p className="text-muted-foreground text-xs">Not run: the conversation moved on.</p>}
    </div>
  )
}

function ToolCall({ part, onApproval }: { part: ToolPart; onApproval: ((id: string, approved: boolean) => void) | null }) {
  const awaiting = part.state === 'approval-requested'
  return (
    <Tool defaultOpen={part.state === 'output-error'}>
      {part.type === 'dynamic-tool'
        ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
        : <ToolHeader type={part.type} state={part.state} />}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
      {awaiting && <ToolApproval part={part} onAnswer={onApproval ? (approved) => onApproval(part.approval.id, approved) : null} />}
    </Tool>
  )
}

/** Saved conversations: the sidebar on wide screens, a drawer on phones. */
function ThreadList({ threads, loading, activeId, onOpen, onRemove }: {
  threads: ChatThread[]
  loading: boolean
  activeId: string
  onOpen: (threadId: string) => void
  onRemove: (threadId: string) => void
}) {
  if (threads.length === 0) return <p className="px-2 py-3 text-muted-foreground text-xs">{loading ? 'Loading…' : 'Your conversations show up here.'}</p>
  return threads.map((thread) => (
    <div key={thread.id} className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${thread.id === activeId ? 'bg-muted' : 'hover:bg-muted/60'}`}>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(thread.id)} title={thread.title}>
        <span className="block truncate">{thread.title}</span>
        <span className="block truncate text-muted-foreground text-xs">{formatRelative(thread.updatedAt)}{thread.model ? ` · ${thread.model}` : ''}{thread.peerId ? ` · ${shortId(thread.peerId)}` : ''}</span>
      </button>
      {/* Always visible on touch screens, which have no hover. */}
      <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        aria-label={`Delete "${thread.title}"`} onClick={() => onRemove(thread.id)}>
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  ))
}

/**
 * The gateway's web chat: Vercel AI SDK's useChat with the AI Elements
 * components (the shadcn AI chatbot). The agent loop and its tools run in the
 * gateway; models are the gateway's, paid by this workspace through the
 * member's "Web chat" key. Which peer answers is always shown.
 */
export default function Chat() {
  const { workspace, viewer, me } = useConsole()
  // Per member as well as workspace: people sharing a browser must not reopen each other's conversation.
  const storageScope = `${workspace.id}:${me.member.id}`
  const models = useQuery({ queryKey: qk.chatModels(workspace.id), queryFn: () => api.chat.models(workspace.id), staleTime: 60_000 })
  const [modelId, setModelId] = useState<string | null>(() => load(`model:${storageScope}`, null))
  const [peerId, setPeerId] = useState<string | null>(() => load(`peer:${storageScope}`, null))
  const queryClient = useQueryClient()
  const threads = useQuery({ queryKey: qk.chatThreads(workspace.id), queryFn: () => api.chat.threads(workspace.id) })
  const context = useQuery({ queryKey: qk.chatContext(workspace.id), queryFn: () => api.chat.context(workspace.id), staleTime: 30_000 })
  const fillRef = useFillViewport<HTMLDivElement>()
  // The Markdown renderer is a separate download: start it now so answers render fully from the first one.
  useEffect(() => { void loadMarkdown().catch(() => undefined) }, [])
  // The open conversation; a new one gets its id here and is saved on the gateway with its first answer.
  const [chatId, setChatId] = useState<string>(() => load(`chat:${storageScope}`, newChatId()))
  const [historyOpen, setHistoryOpen] = useState(false)
  const [toolSwitches, setToolSwitchesState] = useState<ToolSwitches>(() => ({ web: true, files: true, shell: false, ...load<Partial<ToolSwitches>>('tools', {}) }))
  const setToolSwitch = (name: keyof ToolSwitches, on: boolean) => setToolSwitchesState((current) => {
    const next = { ...current, [name]: on }
    save('tools', next)
    return next
  })
  const model = models.data?.find((entry) => entry.id === modelId)
    ?? (modelId ? models.data?.find((entry) => modelKey(entry.id) === modelKey(modelId)) : undefined) ?? null
  // A model no seller offers any more (sellers drop one while busy): the chat moves on and says so.
  const [goneModel, setGoneModel] = useState<string | null>(null)
  const canSeeWallet = isWorkspaceAdmin(viewer)
  const wallet = useWallet(workspace.id, canSeeWallet)
  const unfunded = !!wallet.data && Number(wallet.data.available) <= 0
  // What automatic routing does for this model with the chat key's policies and the buyer's settings.
  const chatKeyId = context.data?.key.id ?? null
  const preview = useQuery({
    queryKey: ['chat-route-preview', workspace.id, chatKeyId, modelId],
    queryFn: () => api.network.routePreview({ model: modelId!, key: chatKeyId! }),
    enabled: Boolean(modelId && chatKeyId),
    staleTime: 30_000,
  })

  // Default to the most offered tool-capable model once the list is in.
  useEffect(() => {
    if (!models.data?.length || model) return
    const first = models.data.find((entry) => entry.toolUse) ?? models.data[0]!
    if (modelId) setGoneModel(modelId)
    setModelId(first.id)
  }, [models.data, model])
  useEffect(() => { save(`model:${storageScope}`, modelId) }, [storageScope, modelId])
  useEffect(() => { save(`peer:${storageScope}`, peerId) }, [storageScope, peerId])
  useEffect(() => { save(`chat:${storageScope}`, chatId) }, [storageScope, chatId])

  // The transport reads the current choice at send time; the gateway keeps the history, so only the newest message goes.
  const choice = useRef({ workspaceId: workspace.id, model: modelId, peerId, tools: toolSwitches })
  choice.current = { workspaceId: workspace.id, model: modelId, peerId, tools: toolSwitches }
  const transport = useMemo(() => new DefaultChatTransport<ChatMessage>({
    api: `${API_BASE}/chat`,
    credentials: 'same-origin',
    headers: { [CSRF_HEADER]: '1' },
    prepareSendMessagesRequest: ({ id, messages }) => ({ body: { ...choice.current, id, messages: messages.slice(-1) } }),
  }), [])

  // Approve / Deny on a shell command sends the answer back once every request in it is answered; the gateway resumes it.
  const { messages, sendMessage, regenerate, status, stop, error, setMessages, clearError, addToolApprovalResponse } = useChat<ChatMessage>({
    id: chatId,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  })

  // Opening a saved conversation loads it from the gateway (and its model and pinned peer).
  const stored = useQuery({
    queryKey: qk.chatThread(workspace.id, chatId),
    queryFn: () => api.chat.thread(workspace.id, chatId),
    enabled: (threads.data ?? []).some((thread) => thread.id === chatId),
    staleTime: Infinity,
  })
  useEffect(() => {
    if (!stored.data) return
    setMessages(stored.data.messages as ChatMessage[])
    if (stored.data.model) setModelId(stored.data.model)
    setPeerId(stored.data.peerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored.data])
  // The gateway saves the conversation as soon as the message arrives and again when the answer finishes:
  // refresh the list (new titles, order) and the key's spend at both points.
  useEffect(() => {
    if ((status === 'streaming' || status === 'ready') && messages.length > 0) {
      void queryClient.invalidateQueries({ queryKey: qk.chatThreads(workspace.id) })
    }
    if (status === 'ready' && messages.length > 0) {
      queryClient.removeQueries({ queryKey: qk.chatThread(workspace.id, chatId), exact: true })
      void queryClient.invalidateQueries({ queryKey: qk.chatContext(workspace.id) })
      void queryClient.invalidateQueries({ queryKey: ['chat-route-preview', workspace.id] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // A failed turn often means the network changed (a seller dropped the model): refresh what the pickers show.
  useEffect(() => {
    if (!error) return
    void queryClient.invalidateQueries({ queryKey: qk.chatModels(workspace.id) })
    void queryClient.invalidateQueries({ queryKey: ['chat-route-preview', workspace.id] })
    if (canSeeWallet) void queryClient.invalidateQueries({ queryKey: qk.wallet(workspace.id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  const busy = status === 'submitted' || status === 'streaming'
  // This conversation's estimated cost so far; null once any answer's cost is unknown.
  const chatCost = messages.reduce<number | null>((sum, message) => {
    const cost = message.metadata?.costUsd
    if (sum === null || cost === null) return null
    return sum + (cost ?? 0)
  }, 0)
  const send = (message: PromptInputMessage) => {
    const text = message.text.trim()
    if (!text || !modelId || busy) return
    // Listed right away; the gateway's own entry replaces this one once it is saved.
    queryClient.setQueryData<ChatThread[]>(qk.chatThreads(workspace.id), (current = []) => (
      current.some((thread) => thread.id === chatId)
        ? current
        : [{ id: chatId, title: text.replace(/\s+/g, ' ').slice(0, 80), model: modelId, peerId, createdAt: Date.now(), updatedAt: Date.now() }, ...current]
    ))
    void sendMessage({ text })
  }
  const open = (threadId: string) => {
    setHistoryOpen(false)
    if (threadId === chatId || busy) return
    clearError()
    setMessages([])
    setChatId(threadId)
  }
  const newChat = () => {
    setHistoryOpen(false)
    stop()
    clearError()
    setMessages([])
    setChatId(newChatId())
  }
  // Answer the last question again with the next seller routing ranks (pinned, so the switch is visible).
  const tryAnother = (servedPeerId: string) => {
    const ranked = [...(preview.data?.candidates ?? [])].filter((candidate) => candidate.eligible && candidate.rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((candidate) => candidate.peerId.toLowerCase())
    const offered = model?.peers.map((peer) => peer.peerId) ?? []
    const next = [...ranked, ...offered].find((id) => id !== servedPeerId && offered.includes(id))
    if (!next || busy) return
    setPeerId(next)
    choice.current = { ...choice.current, peerId: next }
    clearError()
    void regenerate()
  }
  const remove = useConsoleMutation({
    mutationFn: (threadId: string) => api.chat.deleteThread(workspace.id, threadId),
    onSuccess: (_result, threadId) => { if (threadId === chatId) newChat() },
    invalidate: [qk.chatThreads(workspace.id)],
  })
  const suggestions = [
    'What are today\'s top AI news? Search and cite sources.',
    'Read https://antseed.com and explain how it works in 5 bullets.',
    isOrgAdmin(viewer) ? 'Write a Python script that prints the first 20 primes, save it and run it.' : 'Write a short README for a CLI tool and save it as README.md.',
  ]

  return (
    <div ref={fillRef} className="gc-chat gc-chat-page flex gap-4">
      <aside className="hidden w-60 shrink-0 flex-col gap-2 md:flex" aria-label="Conversations">
        <Button variant="outline" size="sm" className="justify-start gap-2" onClick={newChat} disabled={messages.length === 0 && !busy}>
          <MessageSquarePlusIcon className="size-3.5" /> New chat
        </Button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ThreadList threads={threads.data ?? []} loading={threads.isLoading} activeId={chatId} onOpen={open} onRemove={(id) => remove.mutate(id)} />
        </div>
      </aside>
      <Drawer isOpen={historyOpen} onClose={() => setHistoryOpen(false)} side="left" title="Chats" className="gc-chat gc-chat-history">
        <Button variant="outline" size="sm" className="mb-2 w-full justify-start gap-2" onClick={newChat}>
          <MessageSquarePlusIcon className="size-3.5" /> New chat
        </Button>
        <ThreadList threads={threads.data ?? []} loading={threads.isLoading} activeId={chatId} onOpen={open} onRemove={(id) => remove.mutate(id)} />
      </Drawer>
      <div className="flex min-w-0 flex-1 flex-col gap-3 max-sm:gap-2">
      {/* One slim bar: model · seller, and what this chat has cost. Prices and routing reasons are in hover cards. */}
      <div className="flex min-w-0 items-center gap-0.5 border-b pb-2">
        <Button variant="ghost" size="icon-sm" className="shrink-0 md:hidden" onClick={() => setHistoryOpen(true)} aria-label="Chats">
          <MessagesSquareIcon className="size-4" />
        </Button>
        <h1 className="sr-only">Chat</h1>
        <ModelPicker models={models.data ?? []} value={model} onChange={(id) => { setModelId(id); setPeerId(null); setGoneModel(null) }} />
        <span className="text-muted-foreground" aria-hidden="true">·</span>
        <PeerPicker model={model} value={peerId} onChange={setPeerId} preview={preview.data} previewLoading={preview.isLoading} unfunded={unfunded} />
        <span className="ml-auto shrink-0 pl-2 font-mono text-muted-foreground text-xs" title="Estimated at the serving sellers' prices; the signed amounts are in Logs.">
          {messages.length > 0 ? (chatCost === 0 ? 'Free so far' : <>{estimate(chatCost)}<span className="max-sm:hidden"> this chat</span></>) : ''}
        </span>
        <Button variant="ghost" size="icon-sm" className="shrink-0 md:hidden" onClick={newChat} disabled={messages.length === 0 && !busy} aria-label="New chat">
          <MessageSquarePlusIcon className="size-4" />
        </Button>
      </div>
      {goneModel && model && (
        <p className="text-muted-foreground text-xs">
          <Notice>No seller offers {goneModel} right now (sellers stop offering a model while they are busy), so the chat switched to {model.name}.</Notice>
        </p>
      )}
      {peerId && model && !model.peers.some((peer) => peer.peerId === peerId) && (
        <p className="text-muted-foreground text-xs">
          <Notice>
            {shortId(peerId)} no longer offers {model.name} (sellers stop offering a model while they are busy).{' '}
            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setPeerId(null)}>Use Auto</button> or pick another seller.
          </Notice>
        </p>
      )}
      {!peerId && unfunded && autoPick(preview.data) && !isFreeOffer(autoPick(preview.data)!) && (
        <p className="text-muted-foreground text-xs">
          <Notice>
            No free seller offers {model?.name ?? 'this model'} right now, and the wallet has no funds for a paid one.{' '}
            <a className="font-medium text-foreground underline underline-offset-2" href={href('wallet')} onClick={linkHandler('wallet')}>Add funds</a>
          </Notice>
        </p>
      )}

      <Conversation className="gc-chat-conversation">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-1 sm:px-4">
          {messages.length === 0
            ? (
              <ConversationEmptyState>
                <div className="flex w-full min-w-0 max-w-2xl flex-col items-center gap-2 text-center">
                  <h3 className="font-medium text-base">Ask anything</h3>
                  <p className="text-muted-foreground text-sm">The agent can search and read the web and keep files in this chat's scratch space on the gateway.</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {suggestions.map((text) => (
                      <Suggestion key={text} suggestion={text} onClick={(value) => send({ text: value })}
                        className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 max-sm:w-full max-sm:rounded-xl max-sm:text-left" />
                    ))}
                  </div>
                </div>
              </ConversationEmptyState>
            )
            : messages.map((message, index) => {
              const streaming = busy && index === messages.length - 1
              return (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.parts.map((part, partIndex) => {
                      const key = `${message.id}-${partIndex}`
                      if (part.type === 'text') return <MessageResponse key={key}>{part.text}</MessageResponse>
                      if (part.type === 'reasoning') {
                        return (
                          <Reasoning key={key} isStreaming={streaming && partIndex === message.parts.length - 1}>
                            <ReasoningTrigger />
                            <ReasoningContent>{part.text}</ReasoningContent>
                          </Reasoning>
                        )
                      }
                      if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
                        // Only the latest answer's requests can still be answered; older ones were settled as not run.
                        const answerable = !busy && index === messages.length - 1
                        return <ToolCall key={key} part={part as ToolPart} onApproval={answerable ? (id, approved) => { void addToolApprovalResponse({ id, approved }) } : null} />
                      }
                      return null
                    })}
                  </MessageContent>
                  {message.role === 'assistant' && (() => {
                    const latest = index === messages.length - 1 && !busy
                    const served = message.metadata?.peers.at(-1)?.peerId ?? null
                    return (
                      <AnswerLine message={message} streaming={streaming} model={model} preview={preview.data}
                        actions={latest && served ? {
                          pinned: peerId === served,
                          onPin: () => setPeerId(served),
                          onTryAnother: (model?.peers.length ?? 0) > 1 ? () => tryAnother(served) : null,
                        } : null} />
                    )
                  })()}
                </Message>
              )
            })}
          {busy && isWaitingForModel(messages.at(-1)) && (
            <div className="-mt-4 text-muted-foreground text-sm" role="status"><Shimmer duration={1}>Thinking…</Shimmer></div>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              {/out of AntSeed credits|insufficient_deposits/i.test(error.message)
                ? (
                  <>
                    <span className="font-medium">No free seller took this, and paid ones need funds.</span>{' '}
                    No free seller offers {model?.name ?? 'this model'} right now (free sellers stop offering a model while they are busy),
                    and the {workspace.name} wallet has no deposits for a paid one.{' '}
                    <a className="font-medium underline underline-offset-2" href={href('wallet')} onClick={linkHandler('wallet')}>Add funds</a>, or pick a model marked <Pill tone="free">Free</Pill>.
                  </>
                )
                : /model_not_found|not served by this peer/i.test(error.message)
                  ? (
                    <>
                      <span className="font-medium">The seller stopped offering {model?.name ?? 'this model'}.</span>{' '}
                      Sellers drop a model while they are busy, and the list had not caught up yet. Send again{peerId ? <> after switching to <button type="button" className="font-medium underline underline-offset-2" onClick={() => setPeerId(null)}>Auto</button></> : ''} to use another seller.
                    </>
                  )
                  : <><span className="font-medium">The request failed.</span> {error.message}</>}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput onSubmit={send} className="mx-auto w-full max-w-3xl [&_[data-slot=input-group]]:rounded-3xl">
        <PromptInputBody>
          <PromptInputTextarea placeholder={model ? `Message ${model.name}…` : 'Loading models…'} className="max-sm:min-h-10" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools className="min-w-0 flex-wrap gap-1">
            {model && !model.toolUse
              ? <span className="px-2 text-muted-foreground text-xs">This model cannot use tools</span>
              : (
                <>
                  <ToolSwitch label="Web" on={toolSwitches.web} onChange={(on) => setToolSwitch('web', on)} title="Search and read web pages" />
                  <ToolSwitch label="Files" on={toolSwitches.files} onChange={(on) => setToolSwitch('files', on)} title="Keep files in this chat's scratch space on the gateway" />
                  {isOrgAdmin(viewer) && (
                    <ToolSwitch label="Shell" on={toolSwitches.shell} onChange={(on) => setToolSwitch('shell', on)} icon={<LockIcon className="size-3" />}
                      title="Run commands on the gateway host; you approve each one first (organization admins)" />
                  )}
                </>
              )}
          </PromptInputTools>
          <PromptInputSubmit status={status} onStop={stop} disabled={!modelId} />
        </PromptInputFooter>
      </PromptInput>
      </div>
    </div>
  )
}
