import { join, resolve } from 'node:path'
import type { Command } from 'commander'
import chalk from 'chalk'
import pkg from '../../../../package.json' with { type: 'json' }
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import {
  bundleVerifierLogs,
  createLogRedactor,
  listVerifierLogs,
  redactedConfig,
  sensitiveValues,
  startVerifierRunLog,
  VERIFIER_LOG_RETENTION_DAYS,
} from '../../../verifier/run-log.js'

/** Commands that do an auditor's work; read-only ones would only add noise. */
const LOGGED_COMMANDS = new Set(['run', 'watch', 'submit', 'assignment', 'check', 'reference build'])
const DEFAULT_BUNDLE_DAYS = 7

function verifierCommandName(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current && current.name() !== 'verifier'; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

function logsDirectory(evidenceDir: string | undefined, dataDir: string): string {
  return join(evidenceDir ?? join(dataDir, 'verifier', 'evidence'), 'logs')
}

/** Starts the automatic log of a verifier command. Logging never stops a command from running. */
export async function startVerifierCommandLog(program: Command, actionCommand: Command): Promise<void> {
  const command = verifierCommandName(actionCommand)
  if (!LOGGED_COMMANDS.has(command)) return
  try {
    const globals = getGlobalOptions(program)
    const config = await loadConfig(globals.config)
    const redact = createLogRedactor(sensitiveValues(process.env, config))
    startVerifierRunLog({
      dir: logsDirectory(config.verifier?.evidenceDir, globals.dataDir),
      command,
      argv: process.argv.slice(2),
      version: pkg.version,
      redact,
      onExit: (close) => process.once('exit', (code) => close(code)),
    })
  } catch {
    // Without a readable config the command itself reports the problem.
  }
}

export function registerVerifierLogsCommand(verifier: Command): void {
  verifier
    .command('logs')
    .description(`List this auditor's automatic logs, or pack them into one file to share (kept ${VERIFIER_LOG_RETENTION_DAYS} days)`)
    .option('--bundle', 'write the logs to one .log.gz file, with secrets removed')
    .option('--days <n>', 'how many of the newest daily logs to bundle', String(DEFAULT_BUNDLE_DAYS))
    .option('--out <path>', 'where to write the bundle')
    .action(async (options: { bundle?: boolean; days: string; out?: string }) => {
      const globals = getGlobalOptions(verifier.parent!)
      const config = await loadConfig(globals.config)
      const dir = logsDirectory(config.verifier?.evidenceDir, globals.dataDir)
      const files = await listVerifierLogs(dir)
      if (files.length === 0) {
        console.log(`No logs yet in ${dir}.`)
        return
      }
      if (!options.bundle) {
        console.log(chalk.dim(dir))
        for (const file of files) console.log(`${file.name}  ${(file.bytes / 1_048_576).toFixed(1)} MB`)
        console.log(chalk.dim('Pack them to share: antseed verifier logs --bundle'))
        return
      }
      const days = Number(options.days)
      if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of 1 or more')
      const redact = createLogRedactor(sensitiveValues(process.env, config))
      const outPath = resolve(options.out ?? `antseed-verifier-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log.gz`)
      const header = JSON.stringify({
        cli: pkg.version,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        verifier: redactedConfig(config.verifier, redact),
      }, null, 2)
      const bundled = await bundleVerifierLogs({ files, days, header, redact, outPath })
      console.log(chalk.green(`${outPath}`))
      console.log(`${bundled.files} daily log(s), secrets removed. Nothing is sent: share this file yourself.`)
    })
}
