#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { auditEndpoint } from './audit.js'
import { AnthropicMessagesEndpoint } from './endpoints/anthropic-messages.js'
import { OpenAIChatEndpoint } from './endpoints/openai-chat.js'
import type { ModelEndpoint } from './endpoint.js'
import { resolveAuditReference } from './publication.js'
import { loadReference } from './reference.js'
import { auditSummaryJson, formatAuditSummary, verdictExitCode } from './report.js'

const USAGE = `Usage: antseed-verify --base-url <url> (--reference <file|url|ipfs://cid> | --audit <ipfs://cid>) [options]

Checks whether the model behind an endpoint matches a published KBF model reference.

Options:
  --base-url <url>        Endpoint base URL including the version, e.g. https://openrouter.ai/api/v1
  --reference <source>    KBF reference JSON (path, https URL or ipfs:// URI)
  --audit <ipfs://cid>    Published Antseed model audit; reuses its largest KBF reference
  --model <id>            Model id to request (default: the reference's upstream model)
  --protocol <name>       openai (default) or anthropic
  --api-key-env <name>    Environment variable holding the API key (default: VERIFY_API_KEY)
  --header <k=v>          Extra request header, repeatable
  --probes <n>            Fixed probe count (multiple of 10); default is the smallest powered subset
  --concurrency <n>       Parallel requests (default 4)
  --trust-imported        Accept references marked as imported
  --out <file>            Write the full audit record (including raw responses) as JSON
  --json                  Print the result as JSON
  -h, --help              Show this help

Exit codes: 0 SAME, 1 error, 2 DIFF, 3 UNDETERMINED or UNKNOWN.`

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      reference: { type: 'string' },
      audit: { type: 'string' },
      model: { type: 'string' },
      protocol: { type: 'string', default: 'openai' },
      'api-key-env': { type: 'string', default: 'VERIFY_API_KEY' },
      header: { type: 'string', multiple: true },
      probes: { type: 'string' },
      concurrency: { type: 'string' },
      'trust-imported': { type: 'boolean', default: false },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help || !values['base-url'] || !values.reference === !values.audit) {
    console.log(USAGE)
    return values.help ? 0 : 1
  }

  const loadOptions = { trustImported: values['trust-imported'] }
  const reference = values.audit
    ? (await resolveAuditReference(values.audit, loadOptions)).reference
    : await loadReference(values.reference!, loadOptions)
  const endpoint = createEndpoint({
    protocol: values.protocol ?? 'openai',
    baseUrl: values['base-url'],
    apiKey: process.env[values['api-key-env'] ?? 'VERIFY_API_KEY'],
    headers: parseHeaders(values.header ?? []),
  })
  const result = await auditEndpoint({
    endpoint,
    reference,
    ...(values.model ? { model: values.model } : {}),
    ...(values.probes ? { probeCount: parsePositiveInteger(values.probes, '--probes') } : {}),
    ...(values.concurrency ? { concurrency: parsePositiveInteger(values.concurrency, '--concurrency') } : {}),
    onBatch: values.json
      ? undefined
      : ({ completed, total }) => process.stderr.write(`\r  batches ${completed}/${total}`),
  })
  if (!values.json) process.stderr.write('\n')
  if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`)

  if (values.json) console.log(JSON.stringify(auditSummaryJson(result), null, 2))
  else for (const line of formatAuditSummary(result)) console.log(line)
  return verdictExitCode(result)
}

function createEndpoint(input: {
  protocol: string
  baseUrl: string
  apiKey: string | undefined
  headers: Record<string, string>
}): ModelEndpoint {
  const options = { baseUrl: input.baseUrl, headers: input.headers, ...(input.apiKey ? { apiKey: input.apiKey } : {}) }
  if (input.protocol === 'openai') return new OpenAIChatEndpoint(options)
  if (input.protocol === 'anthropic') return new AnthropicMessagesEndpoint(options)
  throw new Error(`unsupported protocol "${input.protocol}" (expected openai or anthropic)`)
}

function parseHeaders(entries: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) throw new Error(`invalid --header "${entry}" (expected key=value)`)
    headers[entry.slice(0, separator).trim().toLowerCase()] = entry.slice(separator + 1).trim()
  }
  return headers
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
