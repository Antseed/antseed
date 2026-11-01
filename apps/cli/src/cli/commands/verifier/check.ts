import { writeFile } from 'node:fs/promises'
import type { Command } from 'commander'
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
import { loadRevealedBankReference } from '../../../verifier/round/revealed-bank.js'
import { roundStorageFromEnv } from '../../../verifier/round/storage.js'
import { createKbfRoundClient } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface CheckOptions {
  baseUrl: string
  targetModel?: string
  protocol: string
  apiKeyEnv: string
  audit?: string
  epoch?: string
  ipfsGateway?: string
  rpcUrl?: string
  out?: string
  json?: boolean
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
    .description('Audit any OpenAI- or Anthropic-compatible endpoint against the latest revealed verifier question bank for a model')
    .argument('<model>', 'model as audited on-chain, e.g. meta-llama/llama-3.3-70b-instruct')
    .requiredOption('--base-url <url>', 'endpoint base URL including the version, e.g. https://api.example.com/v1')
    .option('--target-model <id>', 'model id to request from the endpoint (default: the reference model)')
    .option('--protocol <name>', 'openai or anthropic', 'openai')
    .option('--api-key-env <name>', 'environment variable holding the endpoint API key', 'VERIFY_API_KEY')
    .option('--epoch <n>', 'use this epoch\'s revealed question bank instead of the latest one')
    .option('--audit <ipfs://cid>', 'use this published audit evidence instead of a revealed question bank')
    .option('--ipfs-gateway <url>', 'use only this IPFS gateway (default: ANTSEED_IPFS_GATEWAYS, else public gateways)')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--out <file>', 'write the full audit record (including raw responses) as JSON')
    .option('--json', 'print the result as JSON')
    .action(async (model: string, options: CheckOptions, command: Command) => {
      const endpoint = createCheckEndpoint(options.protocol, options.baseUrl, process.env[options.apiKeyEnv])
      const log = (message: string): void => {
        if (!options.json) process.stderr.write(`${message}\n`)
      }
      const resolveOptions = options.ipfsGateway ? { ipfsGateway: options.ipfsGateway } : {}

      let reference: ResolvedAuditReference['reference']
      let source: string
      if (options.audit) {
        const resolved = await resolveAuditReference(options.audit, resolveOptions)
        if (resolved.model.trim().toLowerCase() !== model.trim().toLowerCase()) {
          throw new Error(`audit ${resolved.cid} is for ${resolved.model}, not ${model}`)
        }
        reference = resolved.reference
        source = `ipfs://${resolved.cid}`
      } else {
        const config = await loadConfig(getGlobalOptions(command).config)
        const client = createKbfRoundClient(config, options.rpcUrl ? { rpcUrl: options.rpcUrl } : {})
        const storage = roundStorageFromEnv(options.ipfsGateway
          ? { ...process.env, ANTSEED_IPFS_GATEWAYS: options.ipfsGateway, ANTSEED_ROUND_STORAGE_DIR: '' }
          : process.env)
        const revealed = await loadRevealedBankReference({
          client, storage, model,
          ...(options.epoch ? { epoch: BigInt(options.epoch) } : {}),
        })
        log(`Bank       ${revealed.bankUri} (epoch ${revealed.epoch})`)
        reference = revealed.reference
        source = revealed.bankUri
      }

      const result = await auditEndpoint({
        endpoint,
        reference,
        ...(options.targetModel ? { model: options.targetModel } : {}),
        onBatch: options.json
          ? undefined
          : ({ completed, total }) => process.stderr.write(`\r  batches ${completed}/${total}`),
      }).finally(() => {
        if (!options.json) process.stderr.write('\n')
      })
      if (options.out) await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`)
      if (options.json) {
        console.log(JSON.stringify({ ...auditSummaryJson(result), audit: source }, null, 2))
      } else {
        for (const line of formatAuditSummary(result)) console.log(line)
      }
      process.exitCode = verdictExitCode(result)
    })
}
