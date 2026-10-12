import '../chat/chat.css'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { CheckIcon, ChevronsUpDownIcon, KeyRoundIcon, MessageSquarePlusIcon, ServerIcon, ShuffleIcon, Trash2Icon } from 'lucide-react'
import { API_BASE, CSRF_HEADER, api } from '../api'
import type { ApiKey, ChatMessageMetadata, ChatModel, ChatModelPeer, ChatThread, RoutePreview } from '../api/types'
import {
  autoPick, isFreeOffer, MODEL_FILTERS, MODEL_SORTS, PEER_FILTERS, PEER_SORTS, pickModels, pickPeers, verdictsFrom,
  type ModelFilter, type ModelSort, type PeerFilter, type PeerSort,
} from '../lib/chat-pick'
import { useConsole } from '../app/context'
import { isOrgAdmin } from '../lib/nav'
import { qk } from '../lib/queries'
import { useConsoleMutation } from '../lib/mutations'
import { formatRelative, formatTokens, formatUsd, shortId } from '../lib/format'
import { href, linkHandler } from '../lib/router'
import { Button } from '@/chat/components/ui/button'
import { TooltipProvider } from '@/chat/components/ui/tooltip'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/chat/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/chat/components/ai-elements/message'
import {
  ModelSelector, ModelSelectorContent, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorInput, ModelSelectorItem, ModelSelectorList, ModelSelectorName, ModelSelectorTrigger,
} from '@/chat/components/ai-elements/model-selector'
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools, type PromptInputMessage } from '@/chat/components/ai-elements/prompt-input'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/chat/components/ai-elements/reasoning'
import { Suggestion } from '@/chat/components/ai-elements/suggestion'
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

/**
 * Sizes the chat to the window below its own top edge (banners above it vary),
 * so the composer stays on screen and only the conversation scrolls.
 */
function useFillViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const fit = () => {
      const top = element.getBoundingClientRect().top + window.scrollY
      // Whatever the page puts below the chat (its bottom padding) must fit too.
      const below = Math.max(0, document.documentElement.scrollHeight - (top + element.offsetHeight))
      const height = `${Math.max(448, window.innerHeight - top - below)}px`
      if (element.style.height !== height) element.style.height = height
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(document.body)
    window.addEventListener('resize', fit)
    return () => { observer.disconnect(); window.removeEventListener('resize', fit) }
  }, [])
  return ref
}

/** Who pays: the workspace and the API key the chat runs as, with its spend this month against its cap. */
function PaidBy({ apiKey, workspaceName, chatCost }: { apiKey: ApiKey | undefined; workspaceName: string; chatCost: number | null }) {
  if (!apiKey) return <span>Paid by {workspaceName}.</span>
  const caps = [apiKey.limits.monthly, apiKey.ownerLimits?.monthly ?? null].filter((cap): cap is string => cap !== null)
  const cap = caps.length ? caps.reduce((low, next) => (Number(next) < Number(low) ? next : low)) : null
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <KeyRoundIcon className="size-3.5" />
      <span>Paid by {workspaceName} with key</span>
      <a className="font-medium text-foreground underline-offset-2 hover:underline" href={href('keys')} onClick={linkHandler('keys')} title={`Key ${apiKey.id}`}>
        {apiKey.label} <span className="font-mono text-muted-foreground">…{apiKey.hint}</span>
      </a>
      <span>· {formatUsd(apiKey.usage.spentThisMonth)} this month{cap ? ` of ${formatUsd(cap)}` : ''}</span>
      {chatCost !== 0 && <span>· this chat {estimate(chatCost)}</span>}
    </span>
  )
}

function peerLabel(peer: { peerId: string; name: string | null }): string {
  return peer.name ? `${peer.name} (${shortId(peer.peerId)})` : shortId(peer.peerId)
}

/** Which peer answered: the user must always be able to tell where a reply came from. */
function AnsweredBy({ metadata, streaming }: { metadata: ChatMessageMetadata | undefined; streaming: boolean }) {
  if (!metadata) return null
  const peers = metadata.peers
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs" aria-live="polite">
      <ServerIcon className="size-3.5" />
      {peers.length === 0
        ? <span>{streaming ? (metadata.pinnedPeerId ? `Waiting for ${shortId(metadata.pinnedPeerId)}…` : 'Choosing a peer…') : 'No peer answered'}</span>
        : (
          <span>
            Answered by{' '}
            {peers.map((peer, index) => (
              <span key={`${peer.peerId}-${index}`}>
                {index > 0 && ', then '}
                <span className="font-medium text-foreground" title={peer.peerId}>{peerLabel(peer)}</span>
              </span>
            ))}
            {' · '}{metadata.model}{metadata.pinnedPeerId ? ' · pinned' : ''}
            {metadata.usage && (metadata.usage.inputTokens > 0 || metadata.usage.outputTokens > 0) && (
              <>
                {' · '}{formatTokens(metadata.usage.inputTokens)} in / {formatTokens(metadata.usage.outputTokens)} out tokens
                {' · '}<span className="text-foreground" title="At the serving peer's advertised prices; the signed amount is in Logs.">{estimate(metadata.costUsd)}</span>
              </>
            )}
          </span>
        )}
    </div>
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
  const tags = [free && 'Free', tools && 'Tools', reasoning && 'Reasoning', vision && 'Vision', tee && 'TEE'].filter(Boolean) as string[]
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => <span key={tag} className="rounded border px-1 py-px text-[10px] text-muted-foreground leading-none">{tag}</span>)}
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

function ModelPicker({ models, value, onChange }: { models: ChatModel[]; value: ChatModel | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [filters, toggle] = useStoredSet<ModelFilter>('model-filters')
  const [sort, setSort] = useStored<ModelSort>('model-sort', 'popular')
  const shown = pickModels(models, filters, sort)
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-80 justify-between gap-2">
          <span className="truncate">{value ? value.name : 'Pick a model'}</span>
          {value && value.inputUsdPerMillion !== null && (
            <span className="text-muted-foreground text-xs">{value.free ? 'free offers' : `from ${priceRange(value)}`}</span>
          )}
          <ChevronsUpDownIcon className="size-3.5 opacity-60" />
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
                  <span className="block">{model.free ? 'free offers' : `from ${priceRange(model)}`}</span>
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
function autoSummary(pick: ReturnType<typeof autoPick>, model: ChatModel | null, loading: boolean): string {
  if (loading) return 'Checking which seller automatic routing picks…'
  if (!pick) return 'No seller passes your routing settings for this model right now.'
  const peer = model?.peers.find((entry) => entry.peerId === pick.peerId.toLowerCase())
  const name = peer ? peerLabel(peer) : peerLabel({ peerId: pick.peerId, name: pick.displayName })
  return `Right now: ${name} · ${priceRange(pick)}${pick.trustScore !== null ? ` · trust ${Math.round(pick.trustScore)}` : ''}.`
}

function PeerPicker({ model, value, onChange, preview, previewLoading }: {
  model: ChatModel | null
  value: string | null
  onChange: (peerId: string | null) => void
  preview: RoutePreview | undefined
  previewLoading: boolean
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
      <ModelSelectorTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-96 justify-between gap-2" disabled={!model}>
          {pinned ? <ServerIcon className="size-3.5" /> : <ShuffleIcon className="size-3.5" />}
          <span className="truncate">
            {pinned ? peerLabel(pinned) : <>Auto{pickedPeer ? <span className="text-muted-foreground"> · {pickedPeer.name ?? shortId(pickedPeer.peerId)}</span> : ''}</>}
          </span>
          {(pinned ?? pickedPeer) && <span className="text-muted-foreground text-xs">{priceRange((pinned ?? pickedPeer)!)}</span>}
          <ChevronsUpDownIcon className="size-3.5 opacity-60" />
        </Button>
      </ModelSelectorTrigger>
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
                <span className="text-muted-foreground text-xs">{autoSummary(pick, model, previewLoading)}</span>
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
                  <ServerIcon className="mt-0.5 size-3.5" />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className={`flex items-center gap-2 ${skipped ? 'text-muted-foreground' : ''}`}>
                      <ModelSelectorName>{peerLabel(peer)}</ModelSelectorName>
                      {verdict?.eligible && verdict.rank !== null && <span className="text-muted-foreground text-xs">#{verdict.rank}</span>}
                    </span>
                    <Tags free={isFreeOffer(peer)} tools={peer.toolUse} reasoning={peer.reasoning} vision={peer.vision} tee={peer.tee} />
                    {skipped && <span className="text-muted-foreground text-xs">Auto skips it: {verdict.reasons[0] ?? 'not eligible'}. You can still pin it.</span>}
                    {!peer.toolUse && <span className="text-muted-foreground text-xs">No tools: plain chat when pinned.</span>}
                  </span>
                  <span className="ml-auto shrink-0 text-right text-muted-foreground text-xs">
                    {priceRange(peer)}
                    {peer.reputation !== null && <span className="block">trust {Math.round(peer.reputation)}</span>}
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

function ToolCall({ part }: { part: ToolPart }) {
  return (
    <Tool defaultOpen={part.state === 'output-error'}>
      {part.type === 'dynamic-tool'
        ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
        : <ToolHeader type={part.type} state={part.state} />}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  )
}

/**
 * The gateway's web chat: Vercel AI SDK's useChat with the AI Elements
 * components (the shadcn AI chatbot). The agent loop and its tools run in the
 * gateway; models are the gateway's, paid by this workspace through the
 * member's "Web chat" key. Which peer answers is always shown.
 */
export default function Chat() {
  const { workspace, viewer } = useConsole()
  const models = useQuery({ queryKey: qk.chatModels(workspace.id), queryFn: () => api.chat.models(workspace.id), staleTime: 60_000 })
  const [modelId, setModelId] = useState<string | null>(() => load(`model:${workspace.id}`, null))
  const [peerId, setPeerId] = useState<string | null>(() => load(`peer:${workspace.id}`, null))
  const queryClient = useQueryClient()
  const threads = useQuery({ queryKey: qk.chatThreads(workspace.id), queryFn: () => api.chat.threads(workspace.id) })
  const context = useQuery({ queryKey: qk.chatContext(workspace.id), queryFn: () => api.chat.context(workspace.id), staleTime: 30_000 })
  const fillRef = useFillViewport<HTMLDivElement>()
  // The open conversation; a new one gets its id here and is saved on the gateway with its first answer.
  const [chatId, setChatId] = useState<string>(() => load(`chat:${workspace.id}`, newChatId()))
  const model = models.data?.find((entry) => entry.id === modelId) ?? null
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
    setModelId(first.id)
  }, [models.data, model])
  useEffect(() => { save(`model:${workspace.id}`, modelId) }, [workspace.id, modelId])
  useEffect(() => { save(`peer:${workspace.id}`, peerId) }, [workspace.id, peerId])
  useEffect(() => { save(`chat:${workspace.id}`, chatId) }, [workspace.id, chatId])

  // The transport reads the current choice at send time; the gateway keeps the history, so only the newest message goes.
  const choice = useRef({ workspaceId: workspace.id, model: modelId, peerId })
  choice.current = { workspaceId: workspace.id, model: modelId, peerId }
  const transport = useMemo(() => new DefaultChatTransport<ChatMessage>({
    api: `${API_BASE}/chat`,
    credentials: 'same-origin',
    headers: { [CSRF_HEADER]: '1' },
    prepareSendMessagesRequest: ({ id, messages }) => ({ body: { ...choice.current, id, messages: messages.slice(-1) } }),
  }), [])

  const { messages, sendMessage, status, stop, error, setMessages, clearError } = useChat<ChatMessage>({ id: chatId, transport })

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
      queryClient.setQueryData(qk.chatThread(workspace.id, chatId), undefined)
      void queryClient.invalidateQueries({ queryKey: qk.chatContext(workspace.id) })
      void queryClient.invalidateQueries({ queryKey: ['chat-route-preview', workspace.id] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

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
    if (threadId === chatId || busy) return
    clearError()
    setMessages([])
    setChatId(threadId)
  }
  const newChat = () => {
    stop()
    clearError()
    setMessages([])
    setChatId(newChatId())
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
    <TooltipProvider>
      <div ref={fillRef} className="gc-chat gc-chat-page flex gap-4">
        <aside className="hidden w-60 shrink-0 flex-col gap-2 md:flex" aria-label="Conversations">
          <Button variant="outline" size="sm" className="justify-start gap-2" onClick={newChat} disabled={messages.length === 0 && !busy}>
            <MessageSquarePlusIcon className="size-3.5" /> New chat
          </Button>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {(threads.data ?? []).length === 0
              ? <p className="px-2 py-3 text-muted-foreground text-xs">{threads.isLoading ? 'Loading…' : 'Your conversations show up here.'}</p>
              : (threads.data ?? []).map((thread) => (
                <div key={thread.id} className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${thread.id === chatId ? 'bg-muted' : 'hover:bg-muted/60'}`}>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(thread.id)} title={thread.title}>
                    <span className="block truncate">{thread.title}</span>
                    <span className="block truncate text-muted-foreground text-xs">{formatRelative(thread.updatedAt)}{thread.model ? ` · ${thread.model}` : ''}{thread.peerId ? ` · ${shortId(thread.peerId)}` : ''}</span>
                  </button>
                  <button type="button" className="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Delete "${thread.title}"`} onClick={() => remove.mutate(thread.id)}>
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              ))}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto font-semibold text-xl">Chat</h1>
          <ModelPicker models={models.data ?? []} value={model} onChange={(id) => { setModelId(id); setPeerId(null) }} />
          <PeerPicker model={model} value={peerId} onChange={setPeerId} preview={preview.data} previewLoading={preview.isLoading} />
          <Button variant="ghost" size="sm" className="md:hidden" onClick={newChat} disabled={messages.length === 0 && !busy}>
            <MessageSquarePlusIcon className="size-3.5" /> New
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {peerId && model
            ? <>Every turn goes to <span className="font-medium text-foreground">{peerLabel(model.peers.find((p) => p.peerId === peerId) ?? { peerId, name: null })}</span>. Each answer shows the peer that served it.</>
            : <>The gateway routes each turn to the best offer for {model?.name ?? 'the model'}. {autoSummary(autoPick(preview.data), model, preview.isLoading)} Each answer shows the seller that served it; pin one to always use it.</>}
          {' '}Tools run on the gateway.
        </p>
        <p className="text-muted-foreground text-xs">
          <PaidBy apiKey={context.data?.key} workspaceName={context.data?.workspaceName ?? workspace.name} chatCost={chatCost} />
        </p>

        <Conversation className="gc-chat-conversation rounded-xl border bg-card">
          <ConversationContent>
            {messages.length === 0
              ? (
                <ConversationEmptyState>
                  <div className="flex max-w-2xl flex-col items-center gap-2 text-center">
                    <h3 className="font-medium text-base">Ask anything</h3>
                    <p className="text-muted-foreground text-sm">The agent can search and read the web and keep files in this chat's scratch space on the gateway.</p>
                    <div className="mt-3 flex flex-wrap justify-center gap-2">
                      {suggestions.map((text) => <Suggestion key={text} suggestion={text} onClick={(value) => send({ text: value, files: [] })} />)}
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
                        if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) return <ToolCall key={key} part={part as ToolPart} />
                        return null
                      })}
                    </MessageContent>
                    {message.role === 'assistant' && <AnsweredBy metadata={message.metadata} streaming={streaming} />}
                  </Message>
                )
              })}
            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <span className="font-medium">The request failed.</span> {error.message}
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <PromptInput onSubmit={send}>
          <PromptInputBody>
            <PromptInputTextarea placeholder={model ? `Message ${model.name}…` : 'Loading models…'} />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="px-2 text-muted-foreground text-xs">
                {model ? (model.toolUse ? 'Web search, web pages and scratch files' : 'This model cannot use tools; plain chat') : ''}
                {model?.toolUse && isOrgAdmin(viewer) ? ', plus a shell (admins)' : ''}
              </span>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={stop} disabled={!modelId} />
          </PromptInputFooter>
        </PromptInput>
        </div>
      </div>
    </TooltipProvider>
  )
}
