/**
 * `cli_command_run`: which command ran (its fixed name from the command tree,
 * never argv, flags or values), whether it succeeded, and roughly how long it
 * took. Plus the one-time notice that telemetry is on.
 */
import type { Command } from 'commander'
import { createTelemetryClient, durationBucket, type PostHogSender, type TelemetryClient } from '@antseed/telemetry'
import { CLI_EVENT_CATALOG } from './catalog.js'
import {
  cliNoticeText,
  hostedByApp,
  posthogConfig,
  readTelemetryState,
  resolveCliConsent,
  updateTelemetryState,
  walletAddressSync,
} from './settings.js'
import { detectInstallMethod } from '../update/install-method.js'
import pkg from '../../package.json' with { type: 'json' }

/** Long-running servers: their notice goes to the log even without a terminal. */
const SERVER_COMMANDS = new Set(['buyer start', 'gateway start', 'tunnel start'])
const COMMAND_FLUSH_TIMEOUT_MS = 500

/** `buyer start`, `gateway key create`: command names only, from the command tree. */
export function commandPath(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ').toLowerCase()
}

export type CommandTelemetryOptions = {
  configPath: string
  dataDir: string
  command: Command
  argv?: string[]
  env?: NodeJS.ProcessEnv
  stream?: NodeJS.WriteStream
  sender?: PostHogSender
  nowMs?: () => number
}

export type CommandRun = {
  finish: (outcome: 'success' | 'failed') => Promise<void>
}

/**
 * Called before a command runs. Shows the notice once, and returns a handle
 * that reports the run, or null when telemetry is off for this process.
 */
export function beginCommandRun(options: CommandTelemetryOptions): CommandRun | null {
  const env = options.env ?? process.env
  // The desktop and the gateway start CLI children; they report for themselves.
  if (hostedByApp(env)) return null
  if (!resolveCliConsent(options.configPath, env).enabled) return null
  const name = commandPath(options.command)
  const argv = options.argv ?? process.argv
  const stream = options.stream ?? process.stderr
  const state = readTelemetryState(options.dataDir)
  const isFirstRun = state.cliNoticeShownAt === undefined
  if (isFirstRun) {
    const canShow = !argv.includes('--json') && (stream.isTTY || SERVER_COMMANDS.has(name))
    if (!canShow) return null
    stream.write(`${cliNoticeText()}\n`)
    updateTelemetryState(options.dataDir, { cliNoticeShownAt: Date.now() })
  }
  // Servers report `buyer_started` / `gateway_started` instead: they rarely end by returning.
  if (SERVER_COMMANDS.has(name)) return null
  const now = options.nowMs ?? (() => Date.now())
  const startedAt = now()
  let client: TelemetryClient | null = null
  return {
    finish: async (outcome) => {
      try {
        client ??= createTelemetryClient({
          product: 'cli',
          appVersion: pkg.version,
          installSource: detectInstallMethod({ env }).kind,
          catalog: CLI_EVENT_CATALOG,
          getDistinctId: () => walletAddressSync(options.dataDir),
          isEnabled: () => true,
          ...(options.sender ? { sender: options.sender } : { posthog: posthogConfig(env) }),
          geoip: true,
          nowMs: now,
        })
        client.capture('cli_command_run', {
          command: name,
          outcome,
          duration_bucket: durationBucket(now() - startedAt),
          is_first_run: isFirstRun,
        })
        await client.close(COMMAND_FLUSH_TIMEOUT_MS)
      } catch {
        // Telemetry never changes how a command ends.
      }
    },
  }
}
