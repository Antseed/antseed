import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { resolvePluginPackage } from '../../../plugins/registry.js'
import type { SellerCLIConfig, SellerProviderConfig, SellerServiceConfig } from '../../../config/types.js'
import { randomToken, renderTokenPng } from './token-image.js'

export const PROBE_PROMPT = 'The image shows exactly 4 characters (uppercase letters and digits). '
  + 'Reply with only those 4 characters and nothing else. '
  + 'If you cannot see an image, reply with exactly NO_IMAGE.'

export type ProbeStatus = 'pass' | 'fail' | 'suspicious' | 'error' | 'unsupported'

export interface ProbeResult {
  provider: string
  service: string
  upstreamModel: string
  status: ProbeStatus
  detail: string
  reply?: string
}

type UpstreamApi = 'openai-chat' | 'anthropic-messages'

interface UpstreamTarget {
  api: UpstreamApi
  url: string
  apiKey?: string
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** A service claims image input with the `multimodal` tag or `image` in `capabilities.inputs`. */
export function claimsImageInput(service: SellerServiceConfig): boolean {
  return (service.categories ?? []).includes('multimodal')
    || (service.capabilities?.inputs ?? []).includes('image')
}

/** Services that reply in text; an image-generation or edit service is not an OCR target. */
function repliesInText(service: SellerServiceConfig): boolean {
  const outputs = service.capabilities?.outputs
  return outputs === undefined || outputs.includes('text')
}

export interface ClaimedService {
  provider: string
  service: string
  config: SellerServiceConfig
  providerConfig: SellerProviderConfig
}

/** Enabled text services that claim image input, optionally narrowed to some providers or services. */
export function listClaimedServices(
  seller: Pick<SellerCLIConfig, 'providers'>,
  filter: { providers?: string[]; services?: string[] } = {},
): ClaimedService[] {
  const out: ClaimedService[] = []
  for (const [provider, providerConfig] of Object.entries(seller.providers ?? {})) {
    if (filter.providers && !filter.providers.includes(provider)) continue
    for (const [service, config] of Object.entries(providerConfig.services ?? {})) {
      if (filter.services && !filter.services.includes(service)) continue
      if (config.enabled === false || !claimsImageInput(config) || !repliesInText(config)) continue
      out.push({ provider, service, config, providerConfig })
    }
  }
  return out
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * The upstream a provider's plugin forwards to, read from config and the
 * environment the same way `seller start` hands them to the plugin. Plugins
 * whose upstream is not a plain chat API return null.
 */
export function resolveUpstreamTarget(
  providerConfig: SellerProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): UpstreamTarget | null {
  const pluginPackage = resolvePluginPackage(providerConfig.plugin)
  const keyFromEnv = (fallbackVar: string): string | undefined =>
    (providerConfig.apiKeyEnv ? env[providerConfig.apiKeyEnv] : undefined) || env[fallbackVar] || undefined
  const chatPath = (): string => providerConfig.pathRewrite?.['/v1/chat/completions'] ?? '/v1/chat/completions'
  const withKey = (target: UpstreamTarget, apiKey: string | undefined): UpstreamTarget =>
    (apiKey ? { ...target, apiKey } : target)

  switch (pluginPackage) {
    case '@antseed/provider-openai': {
      const baseUrl = providerConfig.baseUrl ?? env['OPENAI_BASE_URL'] ?? 'https://api.openai.com'
      return withKey({ api: 'openai-chat', url: joinUrl(baseUrl, chatPath()) }, keyFromEnv('OPENAI_API_KEY'))
    }
    case '@antseed/provider-local-llm': {
      const baseUrl = providerConfig.baseUrl ?? env['LOCAL_LLM_BASE_URL'] ?? 'http://localhost:11434'
      return withKey({ api: 'openai-chat', url: joinUrl(baseUrl, chatPath()) }, keyFromEnv('LOCAL_LLM_API_KEY'))
    }
    case '@antseed/provider-anthropic':
      // The plugin always talks to Anthropic's API; it has no base URL setting.
      return withKey({ api: 'anthropic-messages', url: 'https://api.anthropic.com/v1/messages' }, keyFromEnv('ANTHROPIC_API_KEY'))
    default:
      return null
  }
}

function buildRequest(target: UpstreamTarget, model: string, png: Buffer): RequestInit {
  const data = png.toString('base64')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let body: unknown
  if (target.api === 'anthropic-messages') {
    if (target.apiKey) headers['x-api-key'] = target.apiKey
    headers['anthropic-version'] = '2023-06-01'
    body = {
      model,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          { type: 'text', text: PROBE_PROMPT },
        ],
      }],
    }
  } else {
    if (target.apiKey) headers['authorization'] = `Bearer ${target.apiKey}`
    body = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROBE_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
        ],
      }],
    }
  }
  return { method: 'POST', headers, body: JSON.stringify(body) }
}

function textOfParts(parts: unknown): string {
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .join('')
}

export function extractReplyText(api: UpstreamApi, payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  if (api === 'anthropic-messages') return textOfParts((payload as { content?: unknown }).content)
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices
  return textOfParts(choices?.[0]?.message?.content)
}

const REFUSAL_PATTERN = /\b(?:can(?:not|'t|’t)|unable to|not able to|don(?:'t|’t)|do not)\b.{0,40}\b(?:see|view|read|process|access|open|interpret)\b|\bno image\b|\btext[- ]only\b|\bas an ai\b/i

/** Grades a reply against the token the image showed. */
export function classifyReply(token: string, reply: string): Pick<ProbeResult, 'status' | 'detail'> {
  const text = reply.trim()
  if (!text) return { status: 'fail', detail: 'empty reply' }
  const upper = text.toUpperCase()
  const compact = upper.replace(/[^A-Z0-9]/g, '')
  if (upper.includes('NO_IMAGE') || compact === 'NOIMAGE') return { status: 'fail', detail: 'model reports it saw no image' }
  if (compact === token || (compact.includes(token) && !REFUSAL_PATTERN.test(text))) {
    return { status: 'pass', detail: `read ${token}` }
  }
  if (REFUSAL_PATTERN.test(text)) return { status: 'fail', detail: 'model refused or cannot see images' }
  if (/^[A-Z0-9]{4}$/.test(compact)) {
    return { status: 'suspicious', detail: `answered ${compact}, expected ${token}: a plausible guess or a misread` }
  }
  return { status: 'fail', detail: `wrong answer, expected ${token}` }
}

export interface ProbeOptions {
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Token generator; tests pin it. */
  makeToken?: () => string
}

function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Sends one freshly drawn token image to the service's upstream and grades the reply. */
export async function probeService(claimed: ClaimedService, options: ProbeOptions = {}): Promise<ProbeResult> {
  const upstreamModel = claimed.config.upstreamModel ?? claimed.service
  const base = { provider: claimed.provider, service: claimed.service, upstreamModel }
  const target = resolveUpstreamTarget(claimed.providerConfig, options.env ?? process.env)
  if (!target) {
    return { ...base, status: 'unsupported', detail: `plugin "${claimed.providerConfig.plugin}" is not probed; check it by hand` }
  }
  const token = (options.makeToken ?? randomToken)()
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const init = buildRequest(target, upstreamModel, renderTokenPng(token))
  try {
    const response = await fetchImpl(target.url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) })
    const raw = await response.text()
    if (!response.ok) {
      return { ...base, status: 'error', detail: `upstream answered HTTP ${response.status}: ${snippet(raw) || response.statusText}` }
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return { ...base, status: 'error', detail: `upstream answered with non-JSON: ${snippet(raw)}` }
    }
    const reply = extractReplyText(target.api, payload)
    return { ...base, ...classifyReply(token, reply), reply }
  } catch (err) {
    return { ...base, status: 'error', detail: `request failed: ${(err as Error).message}` }
  }
}

/** Results that leave a claim unproven: the command exits non-zero on any of them. */
export function isFailingResult(result: ProbeResult): boolean {
  return result.status === 'fail' || result.status === 'suspicious' || result.status === 'error'
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value.split(',').map((item) => item.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

const STATUS_LABEL: Record<ProbeStatus, string> = {
  pass: chalk.green('PASS'),
  fail: chalk.red('FAIL'),
  suspicious: chalk.yellow('SUSPICIOUS'),
  error: chalk.red('ERROR'),
  unsupported: chalk.dim('SKIPPED'),
}

export function registerSellerVerifyTagsCommand(sellerCmd: Command): void {
  sellerCmd
    .command('verify-tags')
    .description('Check that services claiming image input (multimodal tag or image input) can read an image')
    .option('--provider <names>', 'only these providers (comma-separated)')
    .option('--service <ids>', 'only these services (comma-separated)')
    .option('--timeout-ms <milliseconds>', 'per-request timeout', '60000')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      try {
        const timeoutMs = Number(options.timeoutMs)
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
          throw new Error('--timeout-ms must be an integer >= 1')
        }
        const providers = parseList(options.provider)
        const config = await loadConfig(getGlobalOptions(sellerCmd).config)
        const unknown = (providers ?? []).filter((name) => !config.seller.providers?.[name])
        if (unknown.length > 0) throw new Error(`Unknown provider name(s): ${unknown.join(', ')}`)

        const claimed = listClaimedServices(config.seller, {
          ...(providers ? { providers } : {}),
          ...(parseList(options.service) ? { services: parseList(options.service)! } : {}),
        })
        const results: ProbeResult[] = []
        for (const service of claimed) {
          if (!options.json) process.stderr.write(chalk.dim(`Probing ${service.provider}/${service.service}...\n`))
          results.push(await probeService(service, { timeoutMs }))
        }
        const failed = results.filter(isFailingResult)

        if (options.json) {
          console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
        } else if (results.length === 0) {
          console.log('No enabled service claims image input (the multimodal tag or "image" in capabilities.inputs).')
        } else {
          console.log(chalk.bold('Image input claims'))
          for (const result of results) {
            const model = result.upstreamModel === result.service ? '' : chalk.dim(` (${result.upstreamModel})`)
            console.log(`  ${STATUS_LABEL[result.status]}  ${result.provider}/${result.service}${model}  ${result.detail}`)
          }
          console.log('')
          if (failed.length > 0) {
            console.log(chalk.red(`${failed.length} of ${results.length} claimed service(s) did not prove they read images.`))
            console.log('Remove the multimodal tag and "image" input from failing services, or re-run to recheck a suspicious read.')
          } else {
            console.log(chalk.green(`Every probed service read its image (${results.length}).`))
          }
        }
        if (failed.length > 0) process.exitCode = 1
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })
}
