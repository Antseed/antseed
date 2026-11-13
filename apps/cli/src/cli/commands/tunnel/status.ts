import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { tunnelStateFile } from './paths.js'

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function registerTunnelStatusCommand(cmd: Command): void {
  cmd
    .command('status')
    .description('Show public HTTPS tunnel status')
    .option('--json', 'Print machine-readable JSON', false)
    .action(async (options: { json: boolean }) => {
      const dataDir = getGlobalOptions(cmd).dataDir
      let state: Record<string, unknown> = { running: false }
      try {
        state = JSON.parse(await readFile(tunnelStateFile(dataDir), 'utf8')) as Record<string, unknown>
        const pid = Number(state['pid'])
        state.running = Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)
      } catch { /* not configured */ }
      if (options.json) {
        console.log(JSON.stringify(state))
        return
      }
      console.log(`Tunnel: ${state.running ? chalk.green('running') : chalk.dim('stopped')}`)
      if (typeof state['provider'] === 'string') console.log(`Provider: ${state['provider']}`)
      if (state.running && typeof state['baseUrl'] === 'string') console.log(`Base URL: ${state['baseUrl']}`)
    })
}
