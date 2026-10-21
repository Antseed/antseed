import type { Command } from 'commander'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { isValidRoutedModelTarget } from '../../../proxy/request-utils.js'

interface BuyerStateFile {
  state: 'connected' | 'stopped'
  pid: number
  port: number
  pinnedPeerId: string | null
  defaultRoutedModel?: string | null
  [key: string]: unknown
}

function stateFilePath(dataDir: string): string {
  return join(dataDir, 'buyer.state.json')
}

async function readStateFile(dataDir: string): Promise<BuyerStateFile | null> {
  try {
    const raw = await readFile(stateFilePath(dataDir), 'utf-8')
    return JSON.parse(raw) as BuyerStateFile
  } catch {
    return null
  }
}

async function writeStateFile(dataDir: string, data: BuyerStateFile): Promise<void> {
  const tmp = join(dataDir, `.buyer.state.${randomUUID()}.json.tmp`)
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2))
    await rename(tmp, stateFilePath(dataDir))
  } catch (err) {
    console.error(chalk.red(`Failed to write session state: ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function requireRunningBuyer(dataDir: string): Promise<BuyerStateFile> {
  const state = await readStateFile(dataDir)
  if (!state) {
    console.error(chalk.red('No buyer connection found. Run `antseed buyer start` first.'))
    process.exit(1)
  }
  if (state.state !== 'connected' || !isProcessAlive(state.pid)) {
    console.error(chalk.red('Buyer proxy is not running. Run `antseed buyer start` first.'))
    process.exit(1)
  }
  return state
}

export function registerBuyerConnectionCommand(buyerCmd: Command): void {
  const connection = buyerCmd
    .command('connection')
    .description('Manage the active buyer connection session')

  connection
    .command('get')
    .description('Show current session state (pinned peer, default route)')
    .action(async () => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const state = await readStateFile(globalOpts.dataDir)
      if (!state) {
        console.log(chalk.yellow('No buyer connection state found. Run `antseed buyer start` first.'))
        return
      }
      const alive = state.state === 'connected' && isProcessAlive(state.pid)
      console.log(`State:         ${alive ? chalk.green('connected') : chalk.red(state.state ?? 'stopped')}`)
      console.log(`PID:           ${state.pid}`)
      console.log(`Port:          ${state.port}`)
      console.log(`Pinned peer:   ${state.pinnedPeerId ? chalk.cyan(state.pinnedPeerId) : chalk.dim('none')}`)
      console.log(`Default route: ${state.defaultRoutedModel ? chalk.cyan(state.defaultRoutedModel) : chalk.dim('none')}`)
    })

  connection
    .command('set')
    .description('Update the peer pin or default route on the running buyer proxy')
    .option('--peer <peerId>', 'pin all requests to a specific peer ID (40-char hex EVM address)')
    .option('--model <model>', 'default route for the "antseed" model that connected apps use: <service> or <peerId>@<service>')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const state = await requireRunningBuyer(globalOpts.dataDir)

      if (options.peer === undefined && options.model === undefined) {
        console.error(chalk.red('Error: specify --peer and/or --model.'))
        process.exit(1)
      }

      if (options.peer !== undefined) {
        const peer = String(options.peer).trim()
        if (!/^(0x)?[0-9a-f]{40}$/i.test(peer)) {
          console.error(chalk.red('Error: --peer must be a 40-character hex peer ID (EVM address).'))
          process.exit(1)
        }
        state.pinnedPeerId = peer.toLowerCase()
      }

      if (options.model !== undefined) {
        const model = String(options.model).trim()
        if (!isValidRoutedModelTarget(model)) {
          console.error(chalk.red('Error: --model must be <service> or <peerId>@<service>.'))
          process.exit(1)
        }
        state.defaultRoutedModel = model
      }

      await writeStateFile(globalOpts.dataDir, state)

      if (options.peer !== undefined) console.log(chalk.green(`Pinned peer set to: ${state.pinnedPeerId}`))
      if (options.model !== undefined) console.log(chalk.green(`Default route set to: ${state.defaultRoutedModel}`))
    })

  connection
    .command('clear')
    .description('Clear the session peer pin and default route')
    .action(async () => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const state = await requireRunningBuyer(globalOpts.dataDir)

      state.pinnedPeerId = null
      state.defaultRoutedModel = null

      await writeStateFile(globalOpts.dataDir, state)

      console.log(chalk.green('Peer pin and default route cleared.'))
    })
}
