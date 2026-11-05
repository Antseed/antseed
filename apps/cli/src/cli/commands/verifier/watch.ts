import type { Command } from 'commander'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import chalk from 'chalk'
import { loadConfig } from '../../../config/loader.js'
import { acquirePidFileLock } from '../../../verifier/atomic-files.js'
import { promptHidden } from '../../prompt-hidden.js'
import { getAddress } from 'ethers'
import { loadKeystoreSigner } from './auditor-identity.js'
import { RUN_TUNING_OPTIONS, auditEpochReader, chainClock, runTuningArgs, validateRunTuningOptions, type RunOptions } from './run.js'
import { resolveAuditEpochWindow } from '../../../verifier/audit-epoch.js'
import { getGlobalOptions, type GlobalOptions } from '../types.js'

/** Besides its own options, `watch` takes `run`'s tuning options (`RUN_TUNING_OPTIONS`) for every tick's run. */
interface WatchOptions extends Pick<RunOptions,
  'enroll' | 'maxEnrollmentRequests' | 'ignorePreRunChecks' | 'maxRounds' | 'confirm'> {
  interval: string
  once?: boolean
  auditor?: string
  keystore?: string
  rpcUrl?: string
  /** `--no-publish-ipfs` sets this to false. */
  publishIpfs?: boolean
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
    // Run's own defaults (rounds, enrollment budget) apply to whatever watch was not given.
    if (options.auditor) args.push('--auditor', options.auditor)
    args.push(...runTuningArgs(options))
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
 * Returns the ticks run and the steps that failed in the last one (what `--once` exits on).
 */
export async function runWatchLoop(input: {
  intervalMs: number
  once: boolean
  signal: AbortSignal
  step: (step: WatchStep) => Promise<number>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  log: (line: string) => void
  now?: () => Date
  /** How long to wait before the next tick; default `intervalMs` (see `nextWatchTickDelayMs`). */
  nextDelayMs?: () => Promise<number>
}): Promise<{ ticks: number; failed: WatchStep[] }> {
  const now = input.now ?? (() => new Date())
  let ticks = 0
  let failed: WatchStep[] = []
  while (!input.signal.aborted) {
    ticks += 1
    failed = []
    input.log(chalk.bold(`\n[${now().toISOString()}] verifier watch: tick ${ticks}`))
    for (const step of ['run', 'submit'] as const) {
      if (input.signal.aborted) break
      const code = await input.step(step)
      if (code !== 0 && !input.signal.aborted) {
        failed.push(step)
        input.log(chalk.yellow(input.once
          ? `verifier ${step} exited with ${code}`
          : `verifier ${step} exited with ${code}; the next tick retries what is left`))
      }
    }
    if (input.once || input.signal.aborted) break
    const delayMs = input.nextDelayMs ? await input.nextDelayMs() : input.intervalMs
    input.log(chalk.dim(delayMs < input.intervalMs
      ? `Next tick in ${Math.max(1, Math.round(delayMs / 60_000))} minute(s), when the next epoch has started.`
      : `Next tick in ${Math.round(delayMs / 60_000)} minute(s).`))
    await input.sleep(delayMs, input.signal)
  }
  return { ticks, failed }
}

/** After the epoch ends, the next tick waits this long, so the chain's next block is in the new epoch. */
export const NEXT_EPOCH_GRACE_SECONDS = 30

/**
 * The wait before the next tick: the interval, or less when the epoch ends sooner, so the new
 * epoch's audits start right after it begins instead of up to one interval later. Late in an epoch
 * `run` opens no new audit window (`MIN_SECONDS_FOR_ANOTHER_ROUND`); this is the other half.
 */
export function nextWatchTickDelayMs(intervalMs: number, epochEndsAt: number, nowSeconds: number): number {
  const untilNextEpochMs = (epochEndsAt - nowSeconds + NEXT_EPOCH_GRACE_SECONDS) * 1_000
  return untilNextEpochMs > 0 ? Math.min(intervalMs, untilNextEpochMs) : intervalMs
}

/**
 * The auditor `run` plans for. `run` has no `--keystore`, so a keystore given only to `watch` would
 * leave `run` assigning models and confirmations to the data-dir identity while `submit` signs as
 * the keystore: pass the keystore's address as `--auditor` instead. A keystore in the config
 * (`verifier.keystore`) needs nothing, since `run` reads it itself.
 */
export function resolveWatchAuditor(
  options: Pick<WatchOptions, 'auditor' | 'keystore'>,
  keystoreSigner: string | undefined,
): string | undefined {
  if (options.auditor || !options.keystore) return options.auditor
  return keystoreSigner
}

/**
 * Unlocks the keystore `submit` will sign with once, when `watch` starts, so a wrong password (or a
 * keystore that signs as another auditor than `--auditor` or `verifier.auditor`) stops `watch` at
 * once instead of at the first submit, after a whole run. Returns the signer's address.
 */
export async function unlockWatchKeystore(
  keystore: string,
  expected: { auditor?: string; configAuditor?: string },
  unlock: (keystore: string) => Promise<{ address: string }> = loadKeystoreSigner,
): Promise<string> {
  let address: string
  try {
    address = getAddress((await unlock(keystore)).address)
  } catch (error) {
    throw new Error(`could not unlock the keystore ${keystore} (${error instanceof Error ? error.message : String(error)}); check the password or ANTSEED_KEYSTORE_PASSWORD`)
  }
  for (const [from, auditor] of [['--auditor', expected.auditor], ['verifier.auditor', expected.configAuditor]] as const) {
    if (auditor && getAddress(auditor) !== address) {
      throw new Error(`${from} ${getAddress(auditor)} does not match the keystore ${keystore}, which signs as ${address}`)
    }
  }
  return address
}

export function parseWatchInterval(value: string): number {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 1) throw new Error('--interval must be at least 1 minute')
  return Math.round(minutes * 60_000)
}

export function registerVerifierWatchCommand(verifier: Command): void {
  const watch = verifier
    .command('watch')
    .description('keep auditing: every interval, run this auditor\'s assigned models and the reports from other auditors waiting for its confirmation, then submit the results')
    .option('--interval <minutes>', 'minutes between ticks', String(DEFAULT_WATCH_INTERVAL_MINUTES))
    .option('--once', 'run one tick (run, then submit) and exit, e.g. from cron')
    .option('--auditor <address>', 'auditor address to assign models for (default: verifier.auditor, verifier.keystore, or the data-dir identity)')
    .option('--keystore <path>', 'sign with this encrypted JSON keystore; the password is read from ANTSEED_KEYSTORE_PASSWORD or asked once at start')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override for submissions')
    .option('--no-publish-ipfs', 'do not publish audit evidence to IPFS (by default it is pinned to Pinata; needs PINATA_JWT)')
    .option('--skip-version-check', 'run even if the latest release audits differently from this CLI')
  for (const option of RUN_TUNING_OPTIONS) watch.option(option.flags, `run: ${option.description}`)
  watch
    .action(async (options: WatchOptions, command: Command) => {
      const intervalMs = parseWatchInterval(options.interval)
      validateRunTuningOptions(options)
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
        process.env['ANTSEED_KEYSTORE_PASSWORD'] = env['ANTSEED_KEYSTORE_PASSWORD']
      }
      const keystoreSigner = keystore
        ? await unlockWatchKeystore(keystore, { auditor: options.auditor, configAuditor: config.verifier?.auditor })
        : undefined
      if (keystoreSigner) console.log(chalk.dim(`Keystore unlocked: submits sign as ${keystoreSigner}`))
      const auditor = resolveWatchAuditor(options, keystoreSigner)
      if (auditor && !options.auditor) console.log(chalk.dim(`Auditing as ${auditor}, the address of ${options.keystore}`))
      const stepOptions: WatchOptions = { ...options, auditor }
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
        const { failed } = await runWatchLoop({
          intervalMs,
          once: options.once === true,
          signal: controller.signal,
          log: (line) => console.log(line),
          sleep: abortableSleep,
          nextDelayMs: async () => {
            try {
              const { window } = await resolveAuditEpochWindow(() => auditEpochReader(config))
              return nextWatchTickDelayMs(intervalMs, window.endsAt, await chainClock(config)())
            } catch {
              return intervalMs
            }
          },
          step: (step) => new Promise<number>((resolve) => {
            console.log(chalk.cyan(`$ antseed verifier ${step}`))
            child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...watchStepArgs(step, globals, stepOptions)], {
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
        // A continuous watch retries on its next tick; `--once` has none, so a failed step is the
        // command's failure (for cron and other supervisors to see).
        if (options.once && failed.length > 0) {
          console.warn(chalk.yellow(`verifier watch --once: ${failed.join(' and ')} failed`))
          process.exitCode = 1
        }
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
