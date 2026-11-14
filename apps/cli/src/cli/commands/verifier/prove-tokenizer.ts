import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { loadConfig } from '../../../config/loader.js'
import { loadBuyerProxySnapshot } from '../../../verifier/model-run.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { modelProbeGenerator, runTokenizerProver, type TokenizerPeer } from '../../../verifier/tokenizer-prover.js'
import { createTokenizerAuditsClient } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'
import { resolveAuditorSigner } from './auditor-identity.js'

interface ProveTokenizerOptions {
  contract?: string
  rpcUrl?: string
  keystore?: string
  dryRun?: boolean
  rounds?: string
  generator?: string
  service?: string[]
  peer?: string[]
  concurrency?: string
  recheckHours?: string
}

/** Dry runs simulate proofs from this placeholder: the results layer never credits the zero address. */
const DRY_RUN_PROVER = '0x000000000000000000000000000000000000dEaD'
const DEFAULT_GENERATOR = 'claude-sonnet-5'
/** Tried (auto-routed) when the generator fails. */
const FALLBACK_GENERATORS = ['claude-sonnet-5', 'gpt-6.1-sol', 'kimi-k3']
const DEFAULT_RECHECK_HOURS = 24

export function registerVerifierProveTokenizerCommand(verifierCmd: Command): void {
  verifierCmd
    .command('prove-tokenizer')
    .description('Probe discovered services with fresh prompts next to live-SAME reference sellers, and prove on-chain, from the sellers\' signed receipts, services whose usage is not their model\'s tokenizer (permissionless; `verifier watch` runs it on every tick)')
    .option('--dry-run', 'simulate the proofs without sending them')
    .option('--contract <address>', 'AntseedTokenizerAudits address (default: the chain\'s, or payments.crypto.tokenizerAuditsAddress)')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--keystore <path>', 'sign proofs with this encrypted JSON keystore instead of verifier.keystore or the data-dir identity')
    .option('--rounds <n>', 'rounds per pass; a suspect must be off in every one (default: the contract minimum)')
    .option('--generator <[peerId@]model>', `model that writes each round's prompt (default ${DEFAULT_GENERATOR})`)
    .option('--service <name...>', 'only these services as suspects')
    .option('--peer <peerId...>', 'only these sellers as suspects')
    .option('--concurrency <n>', 'requests in parallel (default 8)')
    .option('--recheck-hours <hours>', `skip services checked in the last this many hours (default ${DEFAULT_RECHECK_HOURS}; inconclusive ones are retried after 6)`)
    .action(async (options: ProveTokenizerOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const contract = createTokenizerAuditsClient(
        config,
        options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {},
        options.contract,
      )
      if (!contract) {
        console.log(chalk.dim('Tokenizer audits are not deployed on this chain yet: nothing to prove.'))
        return
      }
      const signer = options.dryRun
        ? null
        : await resolveAuditorSigner({ config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore })
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const recheckHours = options.recheckHours === undefined ? DEFAULT_RECHECK_HOURS : nonNegativeNumber(options.recheckHours, '--recheck-hours')
      const generator = parseGenerator(options.generator ?? DEFAULT_GENERATOR)
      if (signer) console.log(chalk.dim(`Proofs are signed by ${signer.address}`))
      else console.log(chalk.dim('Dry run: proofs are simulated, not sent'))

      const proxy = await loadBuyerProxySnapshot(globalOptions.dataDir)
      const reader = await openResponseAuthReader({ dataDir: globalOptions.dataDir })
      try {
        const summary = await runTokenizerProver({
          proxyBaseUrl: proxy.baseUrl,
          peers: proxy.peers as unknown as TokenizerPeer[],
          reader,
          contract,
          generator: modelProbeGenerator({ proxyBaseUrl: proxy.baseUrl, ...generator, fallbackModels: FALLBACK_GENERATORS }),
          signer: signer ? { wallet: signer.wallet, address: signer.address } : null,
          simulateFrom: DRY_RUN_PROVER,
          ...(options.rounds ? { rounds: positiveInteger(options.rounds, '--rounds') } : {}),
          ...(options.service?.length ? { services: options.service } : {}),
          ...(options.peer?.length ? { peerIds: options.peer } : {}),
          ...(options.concurrency ? { concurrency: positiveInteger(options.concurrency, '--concurrency') } : {}),
          recheckAfterMs: recheckHours * 3_600_000,
          statePath: join(evidenceDir, 'tokenizer', 'state.json'),
          evidenceDir,
          log: (line) => console.log(line),
        })
        const count = (outcome: string) => summary.results.filter((r) => r.outcome === outcome).length
        const proved = summary.results.filter((r) => r.txHash).length
        console.log(
          `Pass ${summary.runId}: ${summary.suspects} services on ${summary.models} models, ${count('match')} match, `
          + `${count('mismatch')} mismatch (${proved} proved), ${count('inconclusive')} inconclusive, `
          + `${summary.skipped} skipped. Evidence: ${summary.evidencePath}`,
        )
      } finally {
        reader.close()
      }
    })
}

/** `[peerId@]model`: the model that writes the prompts, pinned to one seller when a peer is given. */
function parseGenerator(spec: string): { model: string; peerId?: string } {
  const at = spec.indexOf('@')
  return at > 0 ? { peerId: spec.slice(0, at), model: spec.slice(at + 1) } : { model: spec }
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function nonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be zero or more`)
  return parsed
}
