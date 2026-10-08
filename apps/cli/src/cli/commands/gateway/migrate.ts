import type { Command } from 'commander'
import chalk from 'chalk'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import pkg from '../../../../package.json' with { type: 'json' }
import {
  BundleError,
  configuredBuyerPort,
  exportGatewayBundle,
  importGatewayBundle,
  MIN_PASSWORD_LENGTH,
  portInUse,
  type BundleSummary,
} from '../../../gateway/bundle.js'
import { normalizePublicUrl, readConsoleLocation } from '../../../gateway/console-location.js'
import { GatewayStore } from '../../../gateway/store.js'
import { getGlobalOptions } from '../types.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { DEFAULT_GATEWAY_PORT, gatewayCliRuntime, printJson } from './shared.js'

/** Reads a password from a file: the first line, without its line ending. */
export function readPasswordFile(path: string): string {
  const raw = readFileSync(path, 'utf8')
  return raw.split(/\r?\n/)[0] ?? ''
}

/** Asks on the terminal without echoing. */
export function promptHidden(question: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) return Promise.reject(new Error('No terminal to ask for the password on; pass --password-file <file>.'))
  return new Promise((resolve, reject) => {
    process.stderr.write(question)
    let value = ''
    const wasRaw = input.isRaw
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const finish = (error?: Error) => {
      input.setRawMode(wasRaw)
      input.pause()
      input.removeListener('data', onData)
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish()
        if (char === '\u0003') return finish(new Error('Cancelled.'))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ') value += char
      }
    }
    input.on('data', onData)
  })
}

async function exportPassword(passwordFile: string | undefined): Promise<string> {
  if (passwordFile) return readPasswordFile(passwordFile)
  const first = await promptHidden(`Bundle password (at least ${MIN_PASSWORD_LENGTH} characters): `)
  if (first.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
  const second = await promptHidden('Repeat the password: ')
  if (first !== second) throw new Error('The passwords do not match.')
  return first
}

function printSummary(summary: BundleSummary, log: (line: string) => void = console.log): void {
  log(`  Workspaces:  ${summary.workspaces.length}`)
  for (const workspace of summary.workspaces) {
    log(chalk.dim(`    ${workspace.name}  wallet ${workspace.wallet}${workspace.address ? ` ${workspace.address}` : ''}`))
  }
  log(`  API keys:    ${summary.activeKeys} active`)
  const active = summary.members.filter((member) => member.status === 'active')
  const owners = active.filter((member) => member.orgRole === 'owner').map((member) => member.email ?? member.label)
  log(`  Members:     ${active.length} active${owners.length > 0 ? ` (owner: ${owners.join(', ')})` : ''}`)
  log('  Wallets:')
  for (const wallet of summary.wallets) {
    log(chalk.dim(`    ${wallet.name.padEnd(12)} ${wallet.address ?? '(unknown)'}${wallet.note ? `  ${wallet.note}` : ''}`))
  }
}

export interface BundleExportOptions { out: string; passwordFile?: string; force?: boolean; json?: boolean }

/**
 * Bundle options on `antseed gateway export`, which also exports the request
 * log as CSV: with `--out`, it writes a migration bundle instead.
 */
export function addBundleExportOptions(cmd: Command): Command {
  return cmd
    .option('--out <file>', 'write a password-encrypted bundle of this whole gateway (keys, members, workspaces, wallets, usage, config) to move it to a server')
    .option('--password-file <file>', 'with --out: read the bundle password from the first line of this file instead of asking')
    .option('--force', 'with --out: replace an existing file', false)
    .option('--json', 'with --out: print machine-readable JSON', false)
}

export async function runBundleExport(cmd: Command, options: BundleExportOptions): Promise<void> {
  const { dataDir, config } = getGlobalOptions(cmd)
  const running: string[] = []
  const buyerPort = configuredBuyerPort(config)
  if (await portInUse(buyerPort)) running.push(`a buyer on port ${buyerPort}`)
  let gatewayPort = DEFAULT_GATEWAY_PORT
  if (existsSync(join(dataDir, 'gateway', 'gateway.db'))) {
    const store = new GatewayStore(dataDir)
    try { gatewayPort = readConsoleLocation(store)?.port ?? DEFAULT_GATEWAY_PORT } finally { store.close() }
  }
  if (gatewayPort !== buyerPort && await portInUse(gatewayPort)) running.push(`a gateway on port ${gatewayPort}`)

  const password = await exportPassword(options.passwordFile)
  const result = await exportGatewayBundle({
    dataDir, configPath: config, outFile: options.out, password, force: options.force === true, cliVersion: pkg.version,
    buyerAddresses: () => gatewayCliRuntime.buyerAddresses(buyerPort),
  })
  if (options.json) {
    printJson({ outFile: result.outFile, bytes: result.bytes, files: result.files, warnings: result.warnings, running, summary: result.summary })
    return
  }
  console.log(chalk.bold(`Wrote ${result.outFile}`) + chalk.dim(` (${Math.ceil(result.bytes / 1024)} KiB, readable only by you)`))
  printSummary(result.summary)
  for (const warning of result.warnings) console.log(chalk.yellow(`warning: ${warning}`))
  if (running.length > 0) {
    console.log(chalk.yellow(`warning: ${running.join(' and ')} ${running.length > 1 ? 'are' : 'is'} still running here. The bundle is a consistent snapshot, but usage after this`))
    console.log(chalk.yellow('         moment is not in it, and two buyers must never pay from the same wallet: stop this one before the server starts.'))
  }
  const file = basename(result.outFile)
  console.log('')
  console.log(chalk.bold('Next steps'))
  console.log(`  1. Copy it to the server:   scp ${file} <user>@<server>:/tmp/${file}`)
  console.log('  2. On the server:')
  console.log(`     curl -fsSL https://antseed.com/install-gateway.sh | sudo bash -s -- --domain llm.example.com --import /tmp/${file}`)
  console.log('  3. Point your apps at the new base URL, e.g. https://llm.example.com/v1 (API keys keep working).')
  console.log('  4. Stop the gateway and buyer on this machine, then delete the bundle from both machines.')
  console.log(chalk.dim('The bundle holds wallet keys: keep the password apart from the file. Guide: https://antseed.com/docs/guides/gateway-server#move-a-local-gateway-to-a-server'))
}

/** `antseed gateway import`; the export side lives on `gateway export --out` (see activity.ts). */
export function registerGatewayMigrateCommands(gateway: Command): void {
  gateway.command('import <bundle>')
    .description('Restore a bundle from `antseed gateway export` into this machine\'s data dir (run it with the gateway and buyer stopped)')
    .option('--password-file <file>', 'read the bundle password from the first line of this file instead of asking')
    .option('--public-url <url>', 'origin the console will be reached at here, e.g. https://llm.example.com (default: localhost only)')
    .option('--port <number>', `gateway port here (default: the bundle's, else ${DEFAULT_GATEWAY_PORT})`, parsePositiveInteger)
    .option('--force', 'move an existing data dir (and config) aside to <dir>.backup-<time> and replace it', false)
    .option('--json', 'print machine-readable JSON', false)
    .action(async (bundle: string, options: { passwordFile?: string; publicUrl?: string; port?: number; force: boolean; json: boolean }) => {
      const { dataDir, config } = getGlobalOptions(gateway)
      const publicUrl = normalizePublicUrl(options.publicUrl)
      const buyerPort = configuredBuyerPort(config)
      for (const port of new Set([buyerPort, options.port ?? DEFAULT_GATEWAY_PORT])) {
        if (await portInUse(port)) {
          throw new Error(`Something is listening on port ${port} (a running buyer or gateway?). Stop it first, e.g. sudo systemctl stop antseed-gateway antseed-buyer.`)
        }
      }
      const password = options.passwordFile ? readPasswordFile(options.passwordFile) : await promptHidden('Bundle password: ')
      let result
      try {
        result = await importGatewayBundle({
          bundleFile: bundle,
          dataDir,
          configPath: config,
          password,
          force: options.force,
          publicUrl,
          ...(options.port ? { port: options.port } : {}),
        })
      } catch (error) {
        if (error instanceof BundleError) throw new Error(error.message)
        throw error
      }
      if (options.json) {
        printJson({
          bundleCreatedAt: result.manifest.createdAt,
          backups: result.backups,
          sessionsCleared: result.sessionsCleared,
          consoleUrl: `${result.newOrigin}/console`,
          passkeysStranded: result.passkeysStranded,
          summary: result.summary,
        })
        return
      }
      console.log(chalk.bold(`Imported the gateway from ${basename(bundle)}`) + chalk.dim(` (exported ${result.manifest.createdAt})`))
      printSummary(result.summary)
      for (const backup of result.backups) console.log(chalk.dim(`  Previous data moved to ${backup}`))
      console.log(chalk.dim(`  Console: ${result.newOrigin}/console. Everyone signs in again here (${result.sessionsCleared} old session(s) ended); API keys keep working.`))
      if (result.passkeysStranded) {
        console.log(chalk.yellow(`Passkeys were created for ${result.previousOrigin ?? 'the old address'} and do not work on ${result.newOrigin}: a passkey is bound to its domain.`))
        console.log(chalk.yellow('Sign in with a wallet or single sign-on if you added one, or add a new passkey with a one-time link:'))
        console.log('  antseed gateway console-link --recover')
      }
    })
}
