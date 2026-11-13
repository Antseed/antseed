import type { Command } from 'commander'
import { registerTunnelStartCommand } from './start.js'
import { registerTunnelStatusCommand } from './status.js'
import { registerTunnelStopCommand } from './stop.js'

export function registerTunnelCommands(program: Command): void {
  const tunnel = program.command('tunnel').description('Expose the buyer API through a secure public HTTPS tunnel')
  registerTunnelStartCommand(tunnel)
  registerTunnelStatusCommand(tunnel)
  registerTunnelStopCommand(tunnel)
}
