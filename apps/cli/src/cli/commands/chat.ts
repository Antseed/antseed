/**
 * `antseed chat`: the gateway's chat in the terminal. The terminal UI is
 * Vercel's `@ai-sdk/tui`; it talks to the same backend as the console's Chat
 * page (`/console/api/chat` on a gateway), so the agent, its tools and the
 * conversation history all live on the gateway, and the API key pays.
 *
 * On the gateway host no key is needed: a "CLI chat" key is created once and
 * kept in the data dir. Against a remote gateway pass `--gateway <url>` and
 * `--key <api key>` (or ANTSEED_GATEWAY_KEY).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import chalk from 'chalk'
import { runAgentTUI } from '@ai-sdk/tui'
import { DefaultChatTransport, type ChatTransport, type UIMessage, type UIMessageChunk } from 'ai'
import { CONSOLE_API_PATH, CONSOLE_CSRF_HEADER, type ChatMessageMetadata, type ChatModel, type ChatThread } from '../../gateway/console-api/types.js'
import { readConsoleLocation } from '../../gateway/console-location.js'
import { GatewayStore } from '../../gateway/store.js'
import { DEFAULT_GATEWAY_PORT } from './gateway/shared.js'
import { getGlobalOptions } from './types.js'

const CLI_CHAT_KEY_LABEL = 'CLI chat'
const CLI_CHAT_KEY_FILE = 'cli-chat.key'

interface ChatOptions {
  gateway?: string
  key?: string
  workspace?: string
  model?: string
  peer?: string
  resume?: string
  history?: boolean
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Chat with an agent through a gateway, in the terminal: web search, web pages and scratch files run on the gateway; history is kept there')
    .option('--gateway <url>', 'gateway origin (default: the gateway on this machine)')
    .option('--key <apiKey>', 'gateway API key that pays (env: ANTSEED_GATEWAY_KEY); on the gateway host one is created for you')
    .option('--workspace <id|name>', 'on the gateway host: the workspace the created CLI chat key pays from (default: the default workspace)')
    .option('--model <id>', 'model id (default: the most offered model that can use tools)')
    .option('--peer <peerId|any>', 'seller to send every turn to; "any" lets the gateway pick the best offer each turn (default: the best-rated seller of the model)')
    .option('--resume <threadId>', 'continue a conversation from `antseed chat --history`')
    .option('--history', 'list your conversations on the gateway and exit', false)
    .action(async (options: ChatOptions, cmd: Command) => {
      try {
        await runChat(cmd, options)
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)))
        process.exitCode = 1
      }
    })
}

/** The key secret for a gateway on this machine: the saved CLI chat key, created (and saved) when missing or revoked. */
function localChatKey(dataDir: string, workspace: string | undefined): string {
  const store = new GatewayStore(dataDir)
  try {
    const file = join(dataDir, 'gateway', CLI_CHAT_KEY_FILE)
    const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    const savedKey = saved ? store.findKeyBySecret(saved) : null
    if (savedKey && savedKey.status === 'active' && (!workspace || savedKey.workspaceId === workspace || store.getWorkspace(savedKey.workspaceId)?.name === workspace)) return saved
    const target = workspace
      ? store.listWorkspaces().find((entry) => entry.id === workspace || entry.name === workspace)
      : store.listWorkspaces().find((entry) => entry.isDefault)
    if (!target) throw new Error(workspace ? `No workspace "${workspace}" on this gateway.` : 'This gateway has no default workspace yet; start it once with `antseed gateway start`.')
    const { key, secret } = store.createKey({ label: CLI_CHAT_KEY_LABEL, workspaceId: target.id, ownerMemberId: null, limits: { daily: null, monthly: null, total: null }, expiresAt: null })
    writeFileSync(file, `${secret}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
    console.error(chalk.dim(`Created API key ${key.id} ("${CLI_CHAT_KEY_LABEL}") in workspace ${target.name}; set limits with \`antseed gateway key limits ${key.id}\`.`))
    return secret
  } finally {
    store.close()
  }
}

function localGatewayOrigin(dataDir: string): string {
  const store = new GatewayStore(dataDir)
  try {
    return `http://127.0.0.1:${readConsoleLocation(store)?.port ?? DEFAULT_GATEWAY_PORT}`
  } finally {
    store.close()
  }
}

/** Signs in to the gateway console with the API key; returns the session cookie. */
async function signIn(origin: string, key: string): Promise<string> {
  const response = await fetch(`${origin}${CONSOLE_API_PATH}/auth/api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CONSOLE_CSRF_HEADER]: '1' },
    body: JSON.stringify({ key }),
  }).catch((error: unknown) => { throw new Error(`Cannot reach the gateway at ${origin}: ${error instanceof Error ? error.message : String(error)}`) })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(`The gateway refused the API key: ${body?.error?.message ?? `HTTP ${response.status}`}`)
  }
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).filter(Boolean).join('; ')
  if (!cookie) throw new Error('The gateway did not start a session (is the console enabled?)')
  return cookie
}

function shortPeer(peerId: string): string {
  return `${peerId.slice(0, 6)}…${peerId.slice(-4)}`
}

function peerLabel(peer: { peerId: string; name: string | null }): string {
  return peer.name ? `${peer.name} (${shortPeer(peer.peerId)})` : shortPeer(peer.peerId)
}

/**
 * The terminal UI shows text, reasoning and tool sections only. So that every
 * answer still says which peer served it, a small "served by" section is
 * added to the stream on this side, from the answer's message metadata.
 */
function withServedBy(transport: ChatTransport<UIMessage>): ChatTransport<UIMessage> {
  return {
    sendMessages: async (options) => {
      const stream = await transport.sendMessages(options)
      let metadata: ChatMessageMetadata | null = null
      let count = 0
      return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          const sent = (chunk as { messageMetadata?: ChatMessageMetadata }).messageMetadata
          if (sent) metadata = sent
          if (chunk.type === 'finish' && metadata) {
            const peers = metadata.peers.length ? metadata.peers.map(peerLabel).join(', then ') : 'no peer answered'
            const toolCallId = `served-by-${Date.now()}-${count++}`
            const line = `Served by ${peers} · ${metadata.model}${metadata.pinnedPeerId ? ' · pinned' : ''}`
            controller.enqueue({ type: 'tool-input-available', toolCallId, toolName: 'served_by', input: {}, dynamic: true, title: line } as UIMessageChunk)
            controller.enqueue({ type: 'tool-output-available', toolCallId, output: metadata.peers.map((peer) => peer.peerId).join(', ') || 'none', dynamic: true } as UIMessageChunk)
          }
          controller.enqueue(chunk)
        },
      }))
    },
    reconnectToStream: (options) => transport.reconnectToStream(options),
  }
}

async function runChat(cmd: Command, options: ChatOptions): Promise<void> {
  const { dataDir } = getGlobalOptions(cmd)
  const remote = options.gateway?.replace(/\/+$/, '')
  const onHost = !remote && existsSync(join(dataDir, 'gateway', 'gateway.db'))
  const origin = remote ?? (onHost ? localGatewayOrigin(dataDir) : `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`)
  const key = options.key ?? process.env['ANTSEED_GATEWAY_KEY'] ?? (onHost ? localChatKey(dataDir, options.workspace) : '')
  if (!key) throw new Error('Pass --key <gateway API key> (or set ANTSEED_GATEWAY_KEY), or run this on the gateway host.')

  const cookie = await signIn(origin, key)
  const headers = { cookie, [CONSOLE_CSRF_HEADER]: '1' }
  const getJson = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${origin}${CONSOLE_API_PATH}${path}`, { headers })
    const body = await response.json().catch(() => null) as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status} from ${path}`)
    return body
  }

  if (options.history) {
    const threads = await getJson<ChatThread[]>('/chat/threads')
    if (threads.length === 0) console.log('No conversations yet.')
    for (const thread of threads) {
      console.log(`${chalk.bold(thread.id)}  ${new Date(thread.updatedAt).toLocaleString()}  ${chalk.dim(thread.model ?? '')}${thread.peerId ? chalk.dim(` @${shortPeer(thread.peerId)}`) : ''}\n  ${thread.title}`)
    }
    return
  }

  const models = await getJson<ChatModel[]>('/chat/models')
  const resumed = options.resume ? await getJson<ChatThread & { messages: unknown[] }>(`/chat/threads/${encodeURIComponent(options.resume)}`) : null
  const modelId = options.model ?? resumed?.model ?? models.find((entry) => entry.toolUse)?.id ?? models[0]?.id
  const model = models.find((entry) => entry.id === modelId)
  if (!modelId || !model) throw new Error(modelId ? `The gateway offers no model "${modelId}". Try one of: ${models.slice(0, 8).map((entry) => entry.id).join(', ')}` : 'The gateway offers no models right now.')

  // The peer is chosen up front so the user knows where the conversation goes; "any" leaves it to the gateway.
  const wanted = options.peer ?? resumed?.peerId ?? 'auto'
  let peerId: string | null = null
  if (wanted === 'auto') peerId = (model.peers.find((peer) => peer.toolUse) ?? model.peers[0])?.peerId ?? null
  else if (wanted !== 'any') {
    const match = model.peers.find((peer) => peer.peerId === wanted.toLowerCase().replace(/^0x/, '') || peer.name?.toLowerCase() === wanted.toLowerCase())
    if (!match) throw new Error(`No seller "${wanted}" offers ${model.name}. Sellers: ${model.peers.map(peerLabel).join(', ') || 'none'}`)
    peerId = match.peerId
  }
  const peer = peerId ? model.peers.find((entry) => entry.peerId === peerId) ?? { peerId, name: null } : null

  const threadId = resumed?.id ?? `cli${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const transport = withServedBy(new DefaultChatTransport<UIMessage>({
    api: `${origin}${CONSOLE_API_PATH}/chat`,
    headers,
    // The gateway keeps the history: only the newest message is sent, under this conversation's id.
    prepareSendMessagesRequest: ({ messages }) => ({ body: { id: threadId, model: modelId, peerId, messages: messages.slice(-1) } }),
  }))

  const where = peer ? `pinned to ${peerLabel(peer)}` : 'any peer (the gateway picks the best offer each turn)'
  await runAgentTUI({
    title: `Antseed chat · ${model.name} · ${where}${resumed ? ` · resumed "${resumed.title}"` : ''}`,
    transport,
    tools: 'auto-collapsed',
    reasoning: 'collapsed',
  })
  console.log(chalk.dim(`Conversation ${threadId} is saved on the gateway. Continue it with: antseed chat --resume ${threadId}`))
}
