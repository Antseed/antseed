import { readFile, unlink } from 'node:fs/promises'
import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { tunnelPidFile, tunnelStateFile } from './paths.js'

export function registerTunnelStopCommand(cmd: Command): void {
  cmd
    .command('stop')
    .description('Stop the public HTTPS tunnel')
    .action(async () => {
      const dataDir = getGlobalOptions(cmd).dataDir
      try {
        const pid = parseInt((await readFile(tunnelPidFile(dataDir), 'utf8')).trim(), 10)
        if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM')
        console.log(chalk.green('Tunnel stop requested.'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        console.log(chalk.dim('Tunnel is not running.'))
      } finally {
        await unlink(tunnelPidFile(dataDir)).catch(() => undefined)
        await unlink(tunnelStateFile(dataDir)).catch(() => undefined)
      }
    })
}
