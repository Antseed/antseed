/**
 * Dev mock of the gateway chat (`VITE_MOCK=1`): a model list and a scripted
 * agent run streamed in the AI SDK UI message stream format, with a web
 * search, a page read, a file write and the peer that answered.
 */
import type { ChatMessageMetadata, ChatModel, ChatModelPeer, ChatThread, ChatThreadDetail } from '../api/types'

const PEER_A = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const PEER_B = '0ee134b462785a6407860278ced89d193e1d6c41'

const PEER_FREE = '1d90f467689d499dc435e5744b4613c3203eb0aa'

export function mockChatModels(): ChatModel[] {
  const peer = (peerId: string, name: string, input: number, output: number, reputation: number, extra: Partial<ChatModelPeer> = {}): ChatModelPeer => ({
    peerId, name, toolUse: true, reasoning: true, vision: false, tee: false, inputUsdPerMillion: input, outputUsdPerMillion: output, cachedInputUsdPerMillion: null, reputation, freeTier: null, ...extra,
  })
  return [
    {
      id: 'kimi-k3', name: 'Kimi K3', toolUse: true, reasoning: true, vision: true, free: false, freeForStakers: false, tee: true, offers: 2, inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5,
      peers: [
        peer(PEER_B, 'Fake Seller Beta', 0.6, 2.5, 81, { vision: true, tee: true }),
        peer(PEER_A, 'Fake Seller Alpha', 0.72, 2.8, 74),
      ],
    },
    {
      id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', toolUse: true, reasoning: true, vision: true, free: true, freeForStakers: false, tee: false, offers: 3, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
      peers: [
        peer(PEER_A, 'Fake Seller Alpha', 0.06, 0.19, 74, { vision: true }),
        peer(PEER_B, 'Fake Seller Beta', 0.07, 0.25, 71),
        peer(PEER_FREE, 'Open Forge', 0, 0, 58, { toolUse: false, reasoning: false }),
      ],
    },
    {
      id: 'qwen3-coder-480b', name: 'Qwen3 Coder 480B', toolUse: true, reasoning: false, vision: false, free: false, freeForStakers: false, tee: false, offers: 1, inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6,
      peers: [peer(PEER_A, 'Fake Seller Alpha', 0.4, 1.6, 74, { reasoning: false })],
    },
    {
      id: 'llama-3.3-70b', name: 'Llama 3.3 70B', toolUse: false, reasoning: false, vision: false, free: false, freeForStakers: false, tee: false, offers: 1, inputUsdPerMillion: 0.12, outputUsdPerMillion: 0.3,
      peers: [peer(PEER_B, 'Fake Seller Beta', 0.12, 0.3, 81, { toolUse: false, reasoning: false })],
    },
  ]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Saved conversations (one demo thread from `antseed chat` to start with). */
const threads = new Map<string, ChatThreadDetail>([[
  'cli-demo', {
    id: 'cli-demo', title: 'Compare the cheapest Kimi K3 offers', model: 'kimi-k3', peerId: PEER_A, createdAt: Date.now() - 3_600_000, updatedAt: Date.now() - 3_600_000,
    messages: [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Compare the cheapest Kimi K3 offers' }] },
      { id: 'a0', role: 'assistant', metadata: { model: 'kimi-k3', pinnedPeerId: PEER_A, peers: [{ peerId: PEER_A, name: 'Fake Seller Alpha' }], usage: { inputTokens: 1_840, cachedInputTokens: 0, outputTokens: 120 }, costUsd: 0.00166 }, parts: [{ type: 'text', text: 'Two sellers offer **Kimi K3** right now: Fake Seller Beta at $0.60/M input and Fake Seller Alpha at $0.72/M.' }] },
    ],
  },
]])

export function mockChatThreads(): ChatThread[] {
  return [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(({ messages: _messages, ...thread }) => thread)
}
export function mockChatThread(id: string): ChatThreadDetail | null {
  return threads.get(id) ?? null
}
export function mockDeleteChatThread(id: string): void {
  threads.delete(id)
}

function retryBase(stored: unknown[], incoming: { id: string } | undefined): unknown[] {
  const at = incoming ? stored.findIndex((message) => (message as { id?: string }).id === incoming.id) : -1
  return at >= 0 ? stored.slice(0, at) : stored
}

export function mockChatStream(body: { id?: string; model?: string; peerId?: string | null; messages?: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }> }): Response {
  const model = body.model ?? 'kimi-k3'
  const pinned = body.peerId ?? null
  const peer = pinned ?? PEER_B
  const name = mockChatModels().flatMap((m) => m.peers).find((p) => p.peerId === peer)?.name ?? null
  const metadata = (peers: ChatMessageMetadata['peers'], done = false): ChatMessageMetadata => ({
    model, pinnedPeerId: pinned, peers,
    ...(peers.length ? { usage: { inputTokens: done ? 9_840 : 3_120, cachedInputTokens: 0, outputTokens: done ? 412 : 96 }, costUsd: done ? 0.00693 : 0.00211 } : {}),
  })
  const served = [{ peerId: peer, name }]
  const chunks: Array<[number, unknown]> = [
    [50, { type: 'start', messageId: `m${Date.now()}`, messageMetadata: metadata([]) }],
    [300, { type: 'start-step' }],
    [200, { type: 'tool-input-available', toolCallId: 't1', toolName: 'web_search', input: { query: 'Antseed peer-to-peer AI network' } }],
    [700, { type: 'tool-output-available', toolCallId: 't1', output: { results: [{ title: 'Antseed — open market for AI inference', url: 'https://antseed.com/', snippet: 'Buy and sell AI inference peer to peer…' }] } }],
    [100, { type: 'finish-step' }],
    [50, { type: 'message-metadata', messageMetadata: metadata(served) }],
    [200, { type: 'start-step' }],
    [200, { type: 'tool-input-available', toolCallId: 't2', toolName: 'web_fetch', input: { url: 'https://antseed.com/' } }],
    [800, { type: 'tool-output-available', toolCallId: 't2', output: { url: 'https://antseed.com/', status: 200, text: 'Antseed is an open, peer-to-peer market for AI inference…' } }],
    [100, { type: 'finish-step' }],
    [200, { type: 'start-step' }],
    [200, { type: 'tool-input-available', toolCallId: 't3', toolName: 'write_file', input: { path: 'summary.md', content: '# Antseed\n…' } }],
    [400, { type: 'tool-output-available', toolCallId: 't3', output: { path: 'summary.md', bytes: 412 } }],
    [100, { type: 'finish-step' }],
    [200, { type: 'start-step' }],
    [100, { type: 'text-start', id: 'x1' }],
    ...'**Antseed** is an open, peer-to-peer market for AI inference: buyers reach hundreds of models through a local endpoint, and providers are paid per request in USDC on Base.\n\n- Routing picks the best offer per request, or a peer you pin.\n- Every answer here shows which peer served it.\n\nI saved a longer summary as `summary.md` in this chat\'s scratch space.'
      .match(/.{1,24}/gs)!.map((delta): [number, unknown] => [60, { type: 'text-delta', id: 'x1', delta }]),
    [50, { type: 'text-end', id: 'x1' }],
    [50, { type: 'finish-step' }],
    [50, { type: 'finish', messageMetadata: metadata(served, true) }],
  ]
  // Saved like the gateway does: listed as soon as the message arrives, then again with the answer.
  const id = body.id ?? `t${Date.now()}`
  const previous = threads.get(id)
  const user = body.messages?.[body.messages.length - 1]
  const text = user?.parts.find((part) => part.type === 'text')?.text ?? 'New conversation'
  const save = (answer: unknown[]) => threads.set(id, {
    id, title: previous?.title ?? text.slice(0, 80), model, peerId: pinned, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
    // Like the gateway: re-sending a stored message (a retry) replaces everything after it.
    messages: [...retryBase(previous?.messages ?? [], user), ...(user ? [user] : []), ...answer],
  })
  save([])
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [delay, chunk] of chunks) {
        await sleep(delay)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
      save([{ id: `a${Date.now()}`, role: 'assistant', metadata: metadata(served, true), parts: [{ type: 'text', text: 'Antseed is an open, peer-to-peer market for AI inference.' }] }])
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
}
