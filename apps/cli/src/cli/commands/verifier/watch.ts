import type { Command } from 'commander'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import chalk from 'chalk'
import { loadConfig } from '../../../config/loader.js'
import { acquirePidFileLock } from '../../../verifier/atomic-files.js'
import { promptHidden } from '../../prompt-hidden.js'
import { getGlobalOptions, type GlobalOptions } from '../types.js'

interface WatchOptions {
  interval: string
  once?: boolean
  auditor?: string
  keystore?: string
  rpcUrl?: string
  /** `--no-publish-ipfs` sets this to false. */
  publishIpfs?: boolean
  maxEnrollmentRequests?: string
  skipVersionCheck?: boolean
}

export const DEFAULT_WATCH_INTERVAL_MINUTES = 10

export type WatchStep = 'run' | 'submit'

/**
 * One `verifier` subcommand per step, in a child process of this CLI: `run` audits this auditor's
 * assigned models and the reports waiting for its confirmation, and `submit` sends whatever this
 * epoch's runs produced that is not on-chain yet.
 */
export function watchStepArgs(step: WatchStep, globals: Pick<GlobalOptions, 'config' | 'dataDir' | 'verbose'>, options: WatchOptions): string[] {
  const args = ['--data-dir', globals.dataDir, '--config', globals.config, ...(globals.verbose ? ['--verbose'] : []), 'verifier', step]
  if (options.skipVersionCheck) args.push('--skip-version-check')
  if (step === 'run') {
    if (options.auditor) args.push('--auditor', options.auditor)
    if (options.maxEnrollmentRequests) args.push('--max-enrollment-requests', options.maxEnrollmentRequests)
    return args
  }
  args.push('--yes')
  if (options.publishIpfs === false) args.push('--no-publish-ipfs')
  if (options.keystore) args.push('--keystore', options.keystore)
  if (options.rpcUrl) args.push('--rpc-url', options.rpcUrl)
  return args
}

/**
 * Runs `run` then `submit` every `intervalMs` until `signal` aborts (or once). A failed step is
 * logged and the loop goes on: `run` exits non-zero whenever a model had no sellers, and the next
 * tick retries whatever is left. Every tick sees the reports other auditors submitted since the
 * last one, so a DIFF waiting for this auditor's confirmation is audited within one interval.
 */
export async function runWatchLoop(input: {
  intervalMs: number
  once: boolean
  signal: AbortSignal
  step: (step: WatchStep) => Promise<number>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  log: (line: string) => void
  now?: () => Date
}): Promise<number> {
  const now = input.now ?? (() => new Date())
  let ticks = 0
  while (!input.signal.aborted) {
    ticks += 1
    input.log(chalk.bold(`\n[${now().toISOString()}] verifier watch: tick ${ticks}`))
    for (const step of ['run', 'submit'] as const) {
      if (input.signal.aborted) break
      const code = await input.step(step)
      if (code !== 0 && !input.signal.aborted) {
        input.log(chalk.yellow(`verifier ${step} exited with ${code}; the next tick retries what is left`))
      }
    }
    if (input.once || input.signal.aborted) break
    input.log(chalk.dim(`Next tick in ${Math.round(input.intervalMs / 60_000)} minute(s).`))
    await input.sleep(input.intervalMs, input.signal)
  }
  return ticks
}

export function parseWatchInterval(value: string): number {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 1) throw new Error('--interval must be at least 1 minute')
  return Math.round(minutes * 60_000)
}

export function registerVerifierWatchCommand(verifier: Command): void {
  verifier
    .command('watch')
    .description('keep auditing: every interval, run this auditor\'s assigned models and the reports from other auditors waiting for its confirmation, then submit the results')
    .option('--interval <minutes>', 'minutes between ticks', String(DEFAULT_WATCH_INTERVAL_MINUTES))
    .option('--once', 'run one tick (run, then submit) and exit, e.g. from cron')
    .option('--auditor <address>', 'auditor address to assign models for (default: verifier.auditor, verifier.keystore, or the data-dir identity)')
    .option('--keystore <path>', 'sign with this encrypted JSON keystore; the password is read from ANTSEED_KEYSTORE_PASSWORD or asked once at start')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override for submissions')
    .option('--no-publish-ipfs', 'do not publish audit evidence to IPFS (by default it is pinned to Pinata; needs PINATA_JWT)')
    .option('--max-enrollment-requests <count>', 'maximum reference requests per model and tick when building fresh questions')
    .option('--skip-version-check', 'run even if this CLI is older than the latest release')
    .action(async (options: WatchOptions, command: Command) => {
      const intervalMs = parseWatchInterval(options.interval)
      const globals = getGlobalOptions(command)
      const config = await loadConfig(globals.config)
      const env = { ...process.env }
      // Every tick signs in a child process, which has no terminal to ask on, so ask once here.
      const keystore = options.keystore ?? config.verifier?.keystore
      if (keystore && !env['ANTSEED_KEYSTORE_PASSWORD']) {
        env['ANTSEED_KEYSTORE_PASSWORD'] = await promptHidden(
          `Keystore password for ${keystore}: `,
          'the keystore needs a terminal to ask for the password, or set ANTSEED_KEYSTORE_PASSWORD.',
        )
      }
      const evidenceDir = config.verifier?.evidenceDir ?? join(globals.dataDir, 'verifier', 'evidence')
      const lock = await acquirePidFileLock(join(evidenceDir, '.watch.lock'))
      const controller = new AbortController()
      let child: ReturnType<typeof spawn> | null = null
      const stop = (signal: NodeJS.Signals) => {
        if (controller.signal.aborted) return
        console.log(chalk.yellow(`\n${signal}: stopping after the current step`))
        controller.abort()
        child?.kill(signal)
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      try {
        console.log(chalk.cyan(
          options.once ? 'verifier watch: one tick' : `verifier watch: a tick every ${Math.round(intervalMs / 60_000)} minute(s); stop with Ctrl-C`,
        ))
        await runWatchLoop({
          intervalMs,
          once: options.once === true,
          signal: controller.signal,
          log: (line) => console.log(line),
          sleep: abortableSleep,
          step: (step) => new Promise<number>((resolve) => {
            console.log(chalk.cyan(`$ antseed verifier ${step}`))
            child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...watchStepArgs(step, globals, options)], {
              env,
              stdio: ['ignore', 'inherit', 'inherit'],
            })
            child.on('error', (error) => {
              console.warn(chalk.yellow(`verifier ${step} could not start: ${error.message}`))
              resolve(1)
            })
            child.on('exit', (code, signal) => {
              child = null
              resolve(code ?? (signal ? 1 : 0))
            })
          }),
        })
      } finally {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        await lock.release()
      }
    })
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
