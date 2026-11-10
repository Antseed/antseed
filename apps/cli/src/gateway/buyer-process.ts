import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { identityPassphraseEnv, PASSPHRASE_ENV } from '@antseed/node'
import { TELEMETRY_HOST_ENV } from '@antseed/telemetry'
import { PASSPHRASE_STDIN_ENV } from '../cli/wallet-passphrase.js'
import { BUYER_RESTART_EXIT_CODE } from '../proxy/buyer-proxy.js'
import { BUYER_STOP_TIMEOUT_MS } from '../shutdown-timeouts.js'

/** A buyer that exits sooner than this after starting counts as failing to start. */
const QUICK_EXIT_MS = 30_000
const MAX_QUICK_EXITS = 3
const RESTART_DELAY_MS = 1_000
export { BUYER_STOP_TIMEOUT_MS } from '../shutdown-timeouts.js'

export interface GatewayBuyerOptions {
  buyerPort: number
  dataDir: string
  configPath: string
  verbose: boolean
  onLog: (message: string) => void
  /** Starts the child process; tests replace it. */
  spawnBuyer?: (args: string[]) => ChildProcess
}

/** Starts the CLI as a supervised buyer child; `cli` is how to run the CLI (tests replace it). */
export function spawnCliBuyer(args: string[], cli: string[] = [...process.execArgv, process.argv[1]!]): ChildProcess {
  // The wallet passphrase (from ANTSEED_PASSPHRASE, or typed on the terminal) goes to the
  // buyer over its stdin, not in its environment, where the OS keeps it readable for as
  // long as the process runs. ANTSEED_PASSPHRASE_FILE is inherited and read by the buyer itself.
  const passphrase = identityPassphraseEnv()[PASSPHRASE_ENV]
  // ANTSEED_TELEMETRY_HOST: the buyer tags its telemetry as run by the gateway.
  const env: NodeJS.ProcessEnv = { ...process.env, ANTSEED_SUPERVISED: '1', [TELEMETRY_HOST_ENV]: 'gateway' }
  delete env[PASSPHRASE_ENV]
  if (passphrase) env[PASSPHRASE_STDIN_ENV] = '1'
  const child = spawn(process.execPath, [...cli, ...args], {
    // ANTSEED_SUPERVISED: the gateway restarts the buyer when it exits, so it may accept the console's restart requests.
    env,
    stdio: [passphrase ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    // Its own process group: Ctrl+C reaches the gateway, which then stops the buyer
    // after itself, instead of the buyer exiting first and being restarted.
    detached: process.platform !== 'win32',
  })
  if (passphrase && child.stdin) {
    // A buyer that exits before reading it closes the pipe; its exit is handled below.
    child.stdin.on('error', () => {})
    child.stdin.end(`${passphrase}\n`)
  }
  return child
}

/**
 * Runs `antseed buyer start` as a child of `antseed gateway start`, prefixes
 * its output with `[buyer]`, and restarts it when it exits, as a supervisor
 * would. A buyer that keeps exiting right after starting (a port taken, a
 * broken config) is given up on after a few tries.
 */
export class GatewayBuyer {
  private _child: ChildProcess | null = null
  private _stopping = false
  private _quickExits = 0
  private _restartTimer: NodeJS.Timeout | null = null

  constructor(private readonly _options: GatewayBuyerOptions) {}

  start(): void {
    const { buyerPort, dataDir, configPath, verbose } = this._options
    const args = [
      '--data-dir', dataDir,
      '--config', configPath,
      ...(verbose ? ['--verbose'] : []),
      'buyer', 'start', '--port', String(buyerPort),
    ]
    const startedAt = Date.now()
    const child = this._options.spawnBuyer ? this._options.spawnBuyer(args) : spawnCliBuyer(args)
    this._child = child
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', (line) => { process.stderr.write(`[buyer] ${line}\n`) })
    }
    child.once('error', (error) => { this._options.onLog(`could not start the buyer: ${error.message}`) })
    child.once('exit', (code, signal) => {
      this._child = null
      if (this._stopping) return
      const quick = code !== BUYER_RESTART_EXIT_CODE && Date.now() - startedAt < QUICK_EXIT_MS
      this._quickExits = quick ? this._quickExits + 1 : 0
      if (this._quickExits >= MAX_QUICK_EXITS) {
        this._options.onLog(`the buyer exited ${MAX_QUICK_EXITS} times right after starting; not restarting it. Fix the cause shown above and restart the gateway.`)
        return
      }
      if (code !== BUYER_RESTART_EXIT_CODE) this._options.onLog(`the buyer exited (${signal ?? `code ${code}`}); restarting it`)
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null
        this.start()
      }, RESTART_DELAY_MS)
    })
  }

  /** Stops the buyer and waits for it to exit. */
  async stop(): Promise<void> {
    this._stopping = true
    if (this._restartTimer) clearTimeout(this._restartTimer)
    const child = this._child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
    child.kill('SIGTERM')
    const timer = setTimeout(() => { child.kill('SIGKILL') }, BUYER_STOP_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
  }
}

const ATTACHED_BUYER_CHECK_MS = 5_000
const ATTACHED_BUYER_MISSED_CHECKS = 2

/**
 * Watches a buyer this gateway found already running and did not start, such
 * as one left behind when an earlier gateway crashed: nothing restarts that
 * one, so requests would wait on it forever. When it is gone, `takeOver` runs.
 * Returns a function that stops watching.
 */
export function watchAttachedBuyer(options: {
  isRunning: () => Promise<boolean>
  takeOver: () => void
  checkMs?: number
}): () => void {
  let missed = 0
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  const check = async (): Promise<void> => {
    const running = await options.isRunning().catch(() => true)
    if (stopped) return
    missed = running ? 0 : missed + 1
    if (missed >= ATTACHED_BUYER_MISSED_CHECKS) {
      options.takeOver()
      return
    }
    schedule()
  }
  const schedule = (): void => {
    timer = setTimeout(() => { void check() }, options.checkMs ?? ATTACHED_BUYER_CHECK_MS)
    timer.unref?.()
  }
  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/**
 * Uses a buyer that is already running, starting one if it goes away. The
 * returned callback ends the watch and stops whichever buyer was started, so a
 * single shutdown callback covers a takeover at any point, including during
 * shutdown itself.
 */
export function superviseAttachedBuyer(options: {
  isRunning: () => Promise<boolean>
  start: () => { stop: () => Promise<void> }
  checkMs?: number
}): () => Promise<void> {
  let buyer: { stop: () => Promise<void> } | null = null
  let stopped = false
  const stopWatching = watchAttachedBuyer({
    isRunning: options.isRunning,
    takeOver: () => {
      if (!stopped) buyer = options.start()
    },
    ...(options.checkMs !== undefined ? { checkMs: options.checkMs } : {}),
  })
  return async () => {
    stopped = true
    stopWatching()
    await buyer?.stop()
  }
}
