import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewayIdentity } from './store.js'

const RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
const PROBE_TIMEOUT_MS = 1_500

/** Environment a parent process may set that must not leak into another identity's buyer. */
const IDENTITY_SCOPED_ENV = ['ANTSEED_IDENTITY_HEX', 'ANTSEED_DATA_DIR', 'ANTSEED_CONFIG']

export interface BuyerSupervisorOptions {
  /** Shared buyer config; each identity overrides only its data dir and port. */
  configPath: string
  onLog?: (message: string) => void
  /** Command that runs this CLI; defaults to the current process's entry point. */
  command?: { executable: string; args: string[] }
  probe?: (port: number) => Promise<boolean>
}

type Supervised = {
  identity: GatewayIdentity
  child: ChildProcess | null
  restarts: number
  restartTimer: ReturnType<typeof setTimeout> | null
  /** A compatible buyer was already serving the port when we looked. */
  external: boolean
}

/** Runs one `antseed buyer start` per managed identity and restarts it if it exits. */
export class BuyerSupervisor {
  private readonly _running = new Map<string, Supervised>()
  private _stopped = false

  constructor(private readonly _options: BuyerSupervisorOptions) {}

  /** Converge on exactly these identities having a buyer. */
  async sync(identities: readonly GatewayIdentity[]): Promise<void> {
    if (this._stopped) return
    const wanted = new Map(identities.filter((identity) => identity.managed && identity.buyerPort !== null)
      .map((identity) => [identity.id, identity]))
    for (const [id, entry] of this._running) {
      if (!wanted.has(id)) {
        this._running.delete(id)
        this._terminate(entry)
      }
    }
    for (const identity of wanted.values()) {
      const entry = this._running.get(identity.id)
      if (entry?.child || entry?.restartTimer) continue
      await this._ensure(identity)
    }
  }

  async stop(): Promise<void> {
    this._stopped = true
    const entries = [...this._running.values()]
    this._running.clear()
    await Promise.all(entries.map((entry) => this._terminate(entry)))
  }

  private async _ensure(identity: GatewayIdentity): Promise<void> {
    const probe = this._options.probe ?? probeBuyer
    if (await probe(identity.buyerPort!)) {
      const entry = this._running.get(identity.id)
      if (!entry?.external) this._options.onLog?.(`buyer for ${identity.id} already running on port ${identity.buyerPort}`)
      this._running.set(identity.id, { identity, child: null, restarts: 0, restartTimer: null, external: true })
      return
    }
    this._spawn(identity, this._running.get(identity.id)?.restarts ?? 0)
  }

  private _spawn(identity: GatewayIdentity, restarts: number): void {
    const command = this._options.command ?? currentCliCommand()
    const env = { ...process.env }
    for (const name of IDENTITY_SCOPED_ENV) delete env[name]
    mkdirSync(identity.dataDir, { recursive: true })
    const log = createWriteStream(join(identity.dataDir, 'buyer.log'), { flags: 'a' })
    const child = spawn(command.executable, [
      ...command.args,
      '--data-dir', identity.dataDir,
      '--config', this._options.configPath,
      'buyer', 'start',
      '--port', String(identity.buyerPort),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.pipe(log)
    child.stderr?.pipe(log)
    const entry: Supervised = { identity, child, restarts, restartTimer: null, external: false }
    this._running.set(identity.id, entry)
    this._options.onLog?.(`started buyer for ${identity.id} on port ${identity.buyerPort} (pid ${child.pid ?? '?'})`)

    const onExit = (reason: string): void => {
      if (entry.child !== child) return
      entry.child = null
      log.end()
      if (this._stopped || this._running.get(identity.id) !== entry) return
      const delay = RESTART_BACKOFF_MS[Math.min(entry.restarts, RESTART_BACKOFF_MS.length - 1)]!
      this._options.onLog?.(`buyer for ${identity.id} ${reason}; restarting in ${delay / 1000}s (log: ${join(identity.dataDir, 'buyer.log')})`)
      entry.restarts += 1
      entry.restartTimer = setTimeout(() => {
        entry.restartTimer = null
        if (!this._stopped && this._running.get(identity.id) === entry) void this._ensure(identity)
      }, delay)
      entry.restartTimer.unref?.()
    }
    child.once('exit', (code, signal) => onExit(`exited (${signal ?? `code ${String(code)}`})`))
    child.once('error', (error) => onExit(`failed to start: ${error.message}`))
  }

  private async _terminate(entry: Supervised): Promise<void> {
    if (entry.restartTimer) clearTimeout(entry.restartTimer)
    entry.restartTimer = null
    const child = entry.child
    entry.child = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 10_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}

function currentCliCommand(): { executable: string; args: string[] } {
  const entry = process.argv[1]
  if (!entry) throw new Error('Cannot locate the antseed CLI entry point to start identity buyers.')
  return { executable: process.execPath, args: [...process.execArgv, entry] }
}

async function probeBuyer(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_antseed/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}
