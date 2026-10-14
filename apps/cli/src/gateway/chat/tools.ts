/**
 * Tools the console chat's agent runs on the gateway host.
 *
 *   web_fetch, web_search   every console member
 *   list/read/write_file    a per-chat scratch directory under the gateway's data dir
 *   run_command             org admins only: a shell in that directory, one approved command at a time
 *
 * The scratch directory confines the file tools, not the shell: a command
 * runs as the gateway's own OS user, with its permissions. That is why the
 * shell is for organization admins, who can run the gateway CLI anyway, and
 * why no command runs without the admin's approval of that exact call: the
 * model's output comes from a network seller (and from any page web_fetch
 * reads), so it must never be able to start a command on its own.
 */
import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

const FETCH_TIMEOUT_MS = 15_000
const MAX_FETCH_BYTES = 2 * 1024 * 1024
const MAX_TOOL_TEXT = 20_000
const MAX_REDIRECTS = 5
const COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_OUTPUT = 20_000
const MAX_FILE_BYTES = 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (compatible; AntseedGatewayChat/1.0)'
/** The tool that runs only after the user approves the exact call. */
export const SHELL_TOOL = 'run_command'

export interface ChatToolOptions {
  /** The chat's scratch directory (created on first use). */
  sandboxDir: string
  /** Offer run_command (org admins). */
  allowShell: boolean
  /**
   * Tool call ids of run_command calls the user approved in this request:
   * run_command refuses any other call, whatever the agent loop decides.
   */
  approvedCommandCalls?: ReadonlySet<string>
  /** Brave Search API key; DuckDuckGo's HTML results without one. */
  braveApiKey?: string | null
  /** Replaces all outbound HTTP (tests); web_fetch then does not pin its connection to the checked addresses. */
  fetchImpl?: typeof fetch
  /** Resolves a host name to its addresses; DNS by default (tests inject). */
  resolveHost?: (host: string) => Promise<string[]>
}

export function chatTools(options: ChatToolOptions): ToolSet {
  const fetchImpl = options.fetchImpl ?? fetch
  const fetchPageImpl: PinnedFetch = options.fetchImpl ? (url, _addresses, init) => fetchImpl(url, init) : fetchPinned
  const resolveHost = options.resolveHost ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address))
  const tools: ToolSet = {
    web_fetch: tool({
      description: 'Fetch a public web page (http or https) and return its readable text. Use it to read pages found with web_search or given by the user.',
      inputSchema: z.object({ url: z.string().describe('Absolute http(s) URL') }),
      execute: async ({ url }) => fetchPage(url, fetchPageImpl, resolveHost),
    }),
    web_search: tool({
      description: 'Search the web. Returns titles, URLs and snippets; read a result with web_fetch.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
      execute: async ({ query, limit }) => searchWeb(query, limit ?? 6, options.braveApiKey ?? null, fetchImpl),
    }),
    list_files: tool({
      description: 'List files in the chat\'s scratch directory (or a subdirectory of it).',
      inputSchema: z.object({ path: z.string().optional().describe('Directory relative to the scratch directory; defaults to its root') }),
      execute: async ({ path }) => listFiles(options.sandboxDir, path ?? '.'),
    }),
    read_file: tool({
      description: 'Read a text file from the chat\'s scratch directory.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => readSandboxFile(options.sandboxDir, path),
    }),
    write_file: tool({
      description: 'Create or overwrite a text file in the chat\'s scratch directory.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => writeSandboxFile(options.sandboxDir, path, content),
    }),
  }
  if (options.allowShell) {
    tools[SHELL_TOOL] = tool({
      description: `Run a shell command in the chat's scratch directory on the gateway host (/bin/sh, ${COMMAND_TIMEOUT_MS / 1000} s timeout). Returns exit code, stdout and stderr. The user approves each command before it runs; if they deny one, do not retry it.`,
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: async ({ command }, { toolCallId }) => {
        if (!options.approvedCommandCalls?.has(toolCallId)) throw new Error('This command was not approved by the user, so it did not run.')
        return runCommand(options.sandboxDir, command)
      },
    })
  }
  return tools
}

// ── Web ─────────────────────────────────────────────────────────────────

const PRIVATE_IPV4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]
// Unspecified, loopback and IPv4-compatible; local-use NAT64; unique-local; link-local; site-local; multicast.
const PRIVATE_IPV6: ReadonlyArray<[string, number]> = [
  ['::', 96], ['64:ff9b:1::', 48], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]

/**
 * Loopback, private, link-local, CGNAT and other non-public ranges: never fetched (the buyer and gateway listen on loopback).
 * A BlockList matches the IPv4 ranges in their IPv4-mapped IPv6 forms too (WHATWG URL writes
 * `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`); their NAT64 (`64:ff9b::/96`) forms are added explicitly.
 */
const PRIVATE_ADDRESSES = (() => {
  const list = new BlockList()
  for (const [network, prefix] of PRIVATE_IPV4) {
    list.addSubnet(network, prefix, 'ipv4')
    list.addSubnet(`64:ff9b::${network}`, 96 + prefix, 'ipv6')
  }
  for (const [network, prefix] of PRIVATE_IPV6) list.addSubnet(network, prefix, 'ipv6')
  return list
})()

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 0) return true
  return PRIVATE_ADDRESSES.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

type HostResolver = (host: string) => Promise<string[]>
/** GETs `url` connecting only to `addresses`, which were checked to be public; redirects are not followed. */
type PinnedFetch = (url: URL, addresses: string[], init: RequestInit) => Promise<Response>

async function assertPublicUrl(raw: string, resolveHost: HostResolver): Promise<{ url: URL; addresses: string[] }> {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`Not a valid URL: ${raw}`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => [])
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}.`)
  if (addresses.some(isPrivateAddress)) throw new Error(`${host} is a private or local address; only public web pages can be fetched.`)
  return { url, addresses }
}

async function fetchPage(raw: string, fetchPinnedImpl: PinnedFetch, resolveHost: HostResolver) {
  let { url, addresses } = await assertPublicUrl(raw, resolveHost)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Connect to the addresses just checked: re-resolving the host could answer with a private one (DNS rebinding).
    const response = await fetchPinnedImpl(url, addresses, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      // Every hop is checked again: a public page must not redirect into the gateway's network.
      ;({ url, addresses } = await assertPublicUrl(new URL(location, url).toString(), resolveHost))
      continue
    }
    const type = response.headers.get('content-type') ?? ''
    const body = await readCapped(response, MAX_FETCH_BYTES)
    const text = /html/i.test(type) ? htmlToText(body) : body
    return { url: url.toString(), status: response.status, contentType: type, text: truncate(text, MAX_TOOL_TEXT) }
  }
  throw new Error(`Too many redirects from ${raw}.`)
}

/** node:http(s) GET whose DNS lookup answers with `addresses`; TLS still verifies the certificate for the URL's host name. */
export function fetchPinned(url: URL, addresses: string[], init: RequestInit): Promise<Response> {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) }))
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, pinned)
    else callback(null, pinned[0]!.address, pinned[0]!.family)
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = init.headers as Record<string, string> | undefined
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { method: 'GET', headers, lookup, signal: init.signal ?? undefined }, (res) => {
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        for (const item of Array.isArray(value) ? value : [value ?? '']) responseHeaders.append(name, item)
      }
      const status = res.statusCode ?? 502
      let body: ReadableStream<Uint8Array> | null = null
      if (status === 204 || status === 205 || status === 304) res.resume()
      else body = Readable.toWeb(res) as ReadableStream<Uint8Array>
      resolvePromise(new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => undefined)
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes))
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Readable text from HTML: drops scripts, styles and markup, keeps line structure. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === '#') return String.fromCodePoint(code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10))
      return ENTITIES[code.toLowerCase()] ?? match
    })
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface SearchResult { title: string; url: string; snippet: string }

async function searchWeb(query: string, limit: number, braveApiKey: string | null, fetchImpl: typeof fetch): Promise<{ results: SearchResult[] }> {
  if (braveApiKey) {
    const response = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: { accept: 'application/json', 'x-subscription-token': braveApiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Brave Search answered ${response.status}.`)
    const body = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
    return { results: (body.web?.results ?? []).slice(0, limit).map((row) => ({ title: htmlToText(row.title ?? ''), url: row.url ?? '', snippet: htmlToText(row.description ?? '') })) }
  }
  const response = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`The search engine answered ${response.status}.`)
  return { results: parseDuckDuckGo(await readCapped(response, MAX_FETCH_BYTES)).slice(0, limit) }
}

/** Results from DuckDuckGo's no-JavaScript HTML page. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const blocks = html.split(/class="result results_links/).slice(1)
  for (const block of blocks) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!link) continue
    let url = link[1]!.replace(/&amp;/g, '&')
    const redirect = /[?&]uddg=([^&]+)/.exec(url)
    if (redirect) url = decodeURIComponent(redirect[1]!)
    if (url.startsWith('//')) url = `https:${url}`
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    results.push({ title: htmlToText(link[2]!), url, snippet: snippet ? htmlToText(snippet[1]!) : '' })
  }
  return results
}

// ── Scratch directory ───────────────────────────────────────────────────

/** A path inside the scratch directory; refuses `..`, absolute paths and symlinks that lead out. */
async function sandboxPath(root: string, path: string): Promise<string> {
  await mkdir(root, { recursive: true })
  const realRoot = await realpath(root)
  const target = resolve(realRoot, path)
  const inside = (candidate: string) => candidate === realRoot || candidate.startsWith(realRoot + sep)
  if (!inside(target)) throw new Error('Paths must stay inside the chat\'s scratch directory.')
  // The deepest existing ancestor must also resolve inside (no symlink escapes).
  let probe = target
  for (;;) {
    try {
      if (!inside(await realpath(probe))) throw new Error('Paths must stay inside the chat\'s scratch directory.')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return target
}

async function listFiles(root: string, path: string) {
  const dir = await sandboxPath(root, path)
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const rows = await Promise.all(entries.slice(0, 500).map(async (entry) => {
    const full = join(dir, entry.name)
    const info = await stat(full).catch(() => null)
    return { path: relative(await realpath(root), full) || '.', type: entry.isDirectory() ? 'directory' : 'file', size: info?.size ?? 0 }
  }))
  return { files: rows }
}

async function readSandboxFile(root: string, path: string) {
  const file = await sandboxPath(root, path)
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`${path} is not a file.`)
  const content = await readFile(file, 'utf8')
  return { path, size: info.size, content: truncate(content, MAX_TOOL_TEXT) }
}

async function writeSandboxFile(root: string, path: string, content: string) {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`Files are limited to ${MAX_FILE_BYTES / 1024} KiB.`)
  const file = await sandboxPath(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return { path, bytes: Buffer.byteLength(content) }
}

function runCommand(root: string, command: string): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  return mkdir(root, { recursive: true }).then(() => new Promise((done) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: root,
      detached: true,
      // A minimal environment: the gateway's own secrets (keys, tokens) stay out of reach of `env`.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root, LANG: process.env['LANG'] ?? 'C.UTF-8', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, COMMAND_TIMEOUT_MS)
    const finish = (exitCode: number | null) => {
      clearTimeout(timer)
      done({ exitCode, timedOut, stdout: truncate(stdout, MAX_COMMAND_OUTPUT), stderr: truncate(stderr, MAX_COMMAND_OUTPUT) })
    }
    child.once('error', (error) => { stderr += error.message; finish(null) })
    child.once('close', (code) => finish(code))
  }))
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]` : text
}
