import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { identityPassphraseEnv } from '@antseed/node'
import { BUYER_RESTART_EXIT_CODE } from '../proxy/buyer-proxy.js'

/** A buyer that exits sooner than this after starting counts as failing to start. */
const QUICK_EXIT_MS = 30_000
const MAX_QUICK_EXITS = 3
const RESTART_DELAY_MS = 1_000
/** The buyer closes its payment channels on the way out; give it time before killing it. */
const STOP_TIMEOUT_MS = 30_000

export interface GatewayBuyerOptions {
  buyerPort: number
  dataDir: string
  configPath: string
  verbose: boolean
  onLog: (message: string) => void
  /** Starts the child process; tests replace it. */
  spawnBuyer?: (args: string[]) => ChildProcess
}

function spawnCliBuyer(args: string[]): ChildProcess {
  return spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], {
    // The gateway restarts the buyer when it exits, so it may accept the console's restart requests.
    // ANTSEED_PASSPHRASE is handed on explicitly: this process removed it from its environment when it read it.
    env: { ...process.env, ...identityPassphraseEnv(), ANTSEED_SUPERVISED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: Ctrl+C reaches the gateway, which then stops the buyer
    // after itself, instead of the buyer exiting first and being restarted.
    detached: process.platform !== 'win32',
  })
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
    const child = (this._options.spawnBuyer ?? spawnCliBuyer)(args)
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
    const timer = setTimeout(() => { child.kill('SIGKILL') }, STOP_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
  }
}
