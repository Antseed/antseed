import { writeFile } from 'node:fs/promises'
import type { Command } from 'commander'
import { modelHash, type ModelAuditedEvent } from '@antseed/node/payments'
import {
  AnthropicMessagesEndpoint,
  OpenAIChatEndpoint,
  auditEndpoint,
  auditSummaryJson,
  formatAuditSummary,
  resolveAuditReference,
  verdictExitCode,
  type ModelEndpoint,
  type ResolvedAuditReference,
} from '@antseed/model-verifier'
import { loadConfig } from '../../../config/loader.js'
import { createVerifierClient } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface CheckOptions {
  baseUrl: string
  targetModel?: string
  protocol: string
  apiKeyEnv: string
  audit?: string
  ipfsGateway?: string
  rpcUrl?: string
  out?: string
  json?: boolean
}

/** Newest `ModelAudited` event that published evidence to IPFS. */
export function latestPublishedAudit(events: readonly ModelAuditedEvent[]): ModelAuditedEvent | null {
  let latest: ModelAuditedEvent | null = null
  for (const event of events) {
    if (!event.evidenceUri.startsWith('ipfs://')) continue
    if (
      !latest
      || event.blockNumber > latest.blockNumber
      || (event.blockNumber === latest.blockNumber && event.logIndex > latest.logIndex)
    ) latest = event
  }
  return latest
}

export function createCheckEndpoint(protocol: string, baseUrl: string, apiKey: string | undefined): ModelEndpoint {
  const options = { baseUrl, ...(apiKey ? { apiKey } : {}) }
  if (protocol === 'openai') return new OpenAIChatEndpoint(options)
  if (protocol === 'anthropic') return new AnthropicMessagesEndpoint(options)
  throw new Error(`unsupported --protocol "${protocol}" (expected openai or anthropic)`)
}

export function registerVerifierCheckCommand(verifier: Command): void {
  verifier
    .command('check')
    .description('Audit any OpenAI- or Anthropic-compatible endpoint against the latest published audit for a model')
    .argument('<model>', 'model as audited on-chain, e.g. meta-llama/llama-3.3-70b-instruct')
    .requiredOption('--base-url <url>', 'endpoint base URL including the version, e.g. https://api.example.com/v1')
    .option('--target-model <id>', 'model id to request from the endpoint (default: the reference model)')
    .option('--protocol <name>', 'openai or anthropic', 'openai')
    .option('--api-key-env <name>', 'environment variable holding the endpoint API key', 'VERIFY_API_KEY')
    .option('--audit <ipfs://cid>', 'use this published audit instead of the latest on-chain one')
    .option('--ipfs-gateway <url>', 'use only this IPFS gateway (default: try ipfs.io, then other public gateways)')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--out <file>', 'write the full audit record (including raw responses) as JSON')
    .option('--json', 'print the result as JSON')
    .action(async (model: string, options: CheckOptions, command: Command) => {
      const endpoint = createCheckEndpoint(options.protocol, options.baseUrl, process.env[options.apiKeyEnv])
      const log = (message: string): void => {
        if (!options.json) process.stderr.write(`${message}\n`)
      }
      const resolveOptions = options.ipfsGateway ? { ipfsGateway: options.ipfsGateway } : {}

      let resolved: ResolvedAuditReference
      if (options.audit) {
        resolved = await resolveAuditReference(options.audit, resolveOptions)
      } else {
        const config = await loadConfig(getGlobalOptions(command).config)
        const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: options.rpcUrl } : {})
        const latest = latestPublishedAudit(await verifierClient.queryModelAudits({ model: modelHash(model) }))
        if (!latest) throw new Error(`no published on-chain audit found for ${model}`)
        log(`Audit      ${latest.evidenceUri} (epoch ${latest.epoch}, block ${latest.blockNumber})`)
        resolved = await resolveAuditReference(latest.evidenceUri, { ...resolveOptions, evidenceHash: latest.evidenceHash })
      }
      if (resolved.model.trim().toLowerCase() !== model.trim().toLowerCase()) {
        throw new Error(`audit ${resolved.cid} is for ${resolved.model}, not ${model}`)
      }

      const result = await auditEndpoint({
        endpoint,
        reference: resolved.reference,
        ...(options.targetModel ? { model: options.targetModel } : {}),
        onBatch: options.json
          ? undefined
          : ({ completed, total }) => process.stderr.write(`\r  batches ${completed}/${total}`),
      }).finally(() => {
        if (!options.json) process.stderr.write('\n')
      })
      if (options.out) await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`)
      if (options.json) {
        console.log(JSON.stringify({ ...auditSummaryJson(result), audit: `ipfs://${resolved.cid}` }, null, 2))
      } else {
        for (const line of formatAuditSummary(result)) console.log(line)
      }
      process.exitCode = verdictExitCode(result)
    })
}
