/**
 * Ready-to-paste client snippets pointed at this gateway: one module for the
 * key-created dialog, the per-model copy menus and the seller page's Connect
 * section. A pinned model is `<peerId>@<model>` (peer id without 0x), the
 * format the buyer accepts. Snippets for a model use `$ANTSEED_API_KEY`;
 * only the key-created dialog puts a (new) secret in them.
 */
import type { NetworkModelOffer, NetworkModelType, Peer } from '../api/types'

export function gatewayBaseUrl(publicUrl: string | null | undefined, origin: string): string {
  return (publicUrl || origin).replace(/\/+$/, '')
}

/** The OpenAI-compatible base URL clients are configured with: the gateway base plus `/v1`. */
export function gatewayApiUrl(baseUrl: string): string {
  return `${baseUrl}/v1`
}

export const API_KEY_ENV = 'ANTSEED_API_KEY'

/** The key in a snippet: a literal secret, or an environment variable. */
export type KeyRef = { secret: string } | { env: string }

const ENV_KEY: KeyRef = { env: API_KEY_ENV }

function shellKey(key: KeyRef): string {
  return 'secret' in key ? key.secret : `$${key.env}`
}
function jsKey(key: KeyRef): string {
  return 'secret' in key ? `'${key.secret}'` : `process.env.${key.env}`
}
function pyKey(key: KeyRef): string {
  return 'secret' in key ? `"${key.secret}"` : `os.environ["${key.env}"]`
}

/** `<peerId>@<model>` with the peer id lowercased and without 0x: what the buyer pins on. */
export function pinnedModelId(peerId: string, model: string): string {
  return `${peerId.trim().toLowerCase().replace(/^0x/, '')}@${model.trim()}`
}

export type ApiFormat = 'anthropic-messages' | 'openai-responses' | 'openai-chat-completions' | 'openai-images'

type Service = Pick<Peer['services'][number], 'provider'> & { apiProtocols?: readonly string[] }

/**
 * The API a service speaks: the protocols it announces when the gateway
 * reports them (`apiProtocols`), else a guess from the provider name;
 * chat completions by default.
 */
export function serviceApiFormat(service: Service): ApiFormat {
  const announced = service.apiProtocols ?? []
  if (announced.includes('openai-chat-completions')) return 'openai-chat-completions'
  if (announced.includes('anthropic-messages')) return 'anthropic-messages'
  if (announced.includes('openai-responses')) return 'openai-responses'
  if (announced.includes('openai-images')) return 'openai-images'
  const provider = service.provider.toLowerCase()
  if (provider.includes('anthropic') || provider.includes('claude')) return 'anthropic-messages'
  if (provider.includes('responses')) return 'openai-responses'
  return 'openai-chat-completions'
}

export const API_PATHS: Record<ApiFormat, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-responses': '/v1/responses',
  'openai-chat-completions': '/v1/chat/completions',
  'openai-images': '/v1/images/generations',
}

/**
 * The API to call a network model on through the gateway, or null when the
 * gateway does not serve that kind of model (video, decision). Images go to
 * the images API; a text model pinned to one seller uses the API that seller
 * speaks, and an unpinned one chat completions.
 */
export function modelCallFormat(type: NetworkModelType, offer?: Pick<NetworkModelOffer, 'provider' | 'protocols'> | null): ApiFormat | null {
  if (type === 'image') return 'openai-images'
  if (type !== 'text') return null
  if (!offer) return 'openai-chat-completions'
  const format = serviceApiFormat({ provider: offer.provider, apiProtocols: offer.protocols })
  return format === 'openai-images' ? 'openai-chat-completions' : format
}

const IMAGE_PROMPT = 'A lighthouse on a cliff at dawn, watercolor'

function requestBody(format: ApiFormat, model: string): string {
  if (format === 'anthropic-messages') return JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] })
  if (format === 'openai-responses') return JSON.stringify({ model, input: 'Hello' })
  if (format === 'openai-images') return JSON.stringify({ model, prompt: IMAGE_PROMPT, n: 1 })
  return JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] })
}

/** A ready-to-run curl request; single quotes in the body are escaped for the shell. */
export function curlSnippet(baseUrl: string, model: string, format: ApiFormat = 'openai-chat-completions', key: KeyRef = ENV_KEY): string {
  return [
    `curl ${baseUrl}${API_PATHS[format]} \\`,
    `  -H "Authorization: Bearer ${shellKey(key)}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${requestBody(format, model).replaceAll("'", `'\\''`)}'`,
  ].join('\n')
}

export function openAiJsSnippet(baseUrl: string, model: string, format: ApiFormat = 'openai-chat-completions', key: KeyRef = ENV_KEY): string {
  return [
    "import OpenAI from 'openai'",
    '',
    'const client = new OpenAI({',
    `  baseURL: '${baseUrl}/v1',`,
    `  apiKey: ${jsKey(key)},`,
    '})',
    '',
    ...(format === 'openai-images'
      ? ['const result = await client.images.generate({', `  model: '${model}',`, `  prompt: '${IMAGE_PROMPT}',`, '})', 'console.log(result.data[0].url ?? result.data[0].b64_json)']
      : format === 'openai-responses'
      ? ['const reply = await client.responses.create({', `  model: '${model}',`, "  input: 'Hello',", '})', 'console.log(reply.output_text)']
      : ['const reply = await client.chat.completions.create({', `  model: '${model}',`, "  messages: [{ role: 'user', content: 'Hello' }],", '})', 'console.log(reply.choices[0].message.content)']),
  ].join('\n')
}

export function openAiPythonSnippet(baseUrl: string, model: string, format: ApiFormat = 'openai-chat-completions', key: KeyRef = ENV_KEY): string {
  return [
    ...('env' in key ? ['import os'] : []),
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url="${baseUrl}/v1", api_key=${pyKey(key)})`,
    '',
    ...(format === 'openai-images'
      ? [`result = client.images.generate(model="${model}", prompt="${IMAGE_PROMPT}")`, 'print(result.data[0].url or result.data[0].b64_json)']
      : format === 'openai-responses'
      ? [`reply = client.responses.create(model="${model}", input="Hello")`, 'print(reply.output_text)']
      : [`reply = client.chat.completions.create(`, `    model="${model}",`, '    messages=[{"role": "user", "content": "Hello"}],', ')', 'print(reply.choices[0].message.content)']),
  ].join('\n')
}

export function anthropicJsSnippet(baseUrl: string, model: string, key: KeyRef = ENV_KEY): string {
  return [
    "import Anthropic from '@anthropic-ai/sdk'",
    '',
    'const client = new Anthropic({',
    `  baseURL: '${baseUrl}',`,
    `  authToken: ${jsKey(key)}, // sent as Authorization: Bearer`,
    '})',
    '',
    'const reply = await client.messages.create({',
    `  model: '${model}',`,
    '  max_tokens: 1024,',
    "  messages: [{ role: 'user', content: 'Hello' }],",
    '})',
  ].join('\n')
}

/**
 * Codex's ~/.codex/config.toml provider block. `model` should be a gateway
 * preset (`@preset/<slug>`): with a raw GPT model name Codex switches to a
 * tool format some sellers drop.
 */
export function codexSnippet(baseUrl: string, model: string): string {
  return [
    '# ~/.codex/config.toml',
    `model = "${model}"`,
    'model_provider = "antseed"',
    '',
    '[model_providers.antseed]',
    'name = "Antseed gateway"',
    `base_url = "${baseUrl}/v1"`,
    `env_key = "${API_KEY_ENV}"`,
    // Codex only speaks the Responses API; the buyer translates for chat-completions sellers.
    'wire_api = "responses"',
  ].join('\n')
}

export function claudeCodeSnippet(baseUrl: string, model: string): string {
  return [
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_AUTH_TOKEN="$${API_KEY_ENV}"`,
    `export ANTHROPIC_MODEL="${model}"`,
    'claude',
  ].join('\n')
}

/** Cursor and other OpenAI-compatible tools: the three values to paste in their settings. */
export function openAiCompatibleSnippet(baseUrl: string, model: string): string {
  return [
    `Base URL:  ${baseUrl}/v1`,
    `API key:   $${API_KEY_ENV}  (your Antseed key)`,
    `Model:     ${model}`,
  ].join('\n')
}

export interface Snippet {
  id: string
  label: string
  code: string
}

/** The key-created dialog: the new secret in curl, OpenAI and Anthropic snippets. */
export function keySnippets(baseUrl: string, secret: string, model = '<model>'): Snippet[] {
  const key = { secret }
  return [
    { id: 'curl', label: 'curl', code: curlSnippet(baseUrl, model, 'openai-chat-completions', key) },
    { id: 'openai', label: 'OpenAI SDK', code: openAiJsSnippet(baseUrl, model, 'openai-chat-completions', key) },
    { id: 'anthropic', label: 'Anthropic SDK', code: anthropicJsSnippet(baseUrl, model, key) },
  ]
}

/** The per-model copy menu: model id, curl and the matching SDK call. */
export function modelSnippets(baseUrl: string, peerId: string, model: string, format: ApiFormat): Snippet[] {
  const modelId = pinnedModelId(peerId, model)
  return [
    { id: 'model', label: 'Copy model id', code: modelId },
    { id: 'curl', label: 'Copy curl', code: curlSnippet(baseUrl, modelId, format) },
    format === 'anthropic-messages'
      ? { id: 'sdk', label: 'Copy for Anthropic SDK', code: anthropicJsSnippet(baseUrl, modelId) }
      : { id: 'sdk', label: 'Copy for OpenAI SDK', code: openAiJsSnippet(baseUrl, modelId, format) },
  ]
}

/**
 * A ready-to-run call for `model` (a network model id, `<peerId>@<model>` or
 * a preset): curl and the OpenAI SDKs, plus the Anthropic SDK for a model
 * that speaks Messages. The key is always `$ANTSEED_API_KEY`.
 */
export function apiCallTabs(baseUrl: string, model: string, format: ApiFormat): ConnectTab[] {
  const tabs: ConnectTab[] = [
    { id: 'curl', label: 'curl', language: 'shell', code: curlSnippet(baseUrl, model, format) },
    { id: 'openai-python', label: 'Python', language: 'python', code: openAiPythonSnippet(baseUrl, model, format) },
    { id: 'openai-js', label: 'JavaScript', language: 'javascript', code: openAiJsSnippet(baseUrl, model, format) },
  ]
  if (format === 'anthropic-messages') tabs.push({ id: 'anthropic', label: 'Anthropic SDK', language: 'javascript', code: anthropicJsSnippet(baseUrl, model) })
  return tabs
}

export type ConnectTabId = 'curl' | 'openai-python' | 'openai-js' | 'anthropic' | 'codex' | 'claude-code' | 'openai-compatible'

export interface ConnectTab {
  id: ConnectTabId
  label: string
  code: string
  language: string
}

/**
 * The seller page's Connect tabs for one model. `codexModel` is the preset
 * to put in the Codex config (`@preset/<slug>`), or null when none exists yet.
 */
export function connectTabs(baseUrl: string, peerId: string, model: string, format: ApiFormat, codexModel: string | null): ConnectTab[] {
  const modelId = pinnedModelId(peerId, model)
  const tabs = apiCallTabs(baseUrl, modelId, format)
  // Coding tools only speak the text APIs.
  if (format === 'openai-images') return tabs
  tabs.push(
    { id: 'codex', label: 'Codex', language: 'toml', code: codexSnippet(baseUrl, codexModel ?? '@preset/<your-preset>') },
    { id: 'claude-code', label: 'Claude Code', language: 'shell', code: claudeCodeSnippet(baseUrl, modelId) },
    { id: 'openai-compatible', label: 'Cursor / OpenAI-compatible', language: 'text', code: openAiCompatibleSnippet(baseUrl, modelId) },
  )
  return tabs
}
