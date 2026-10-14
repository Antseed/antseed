import type { Command } from 'commander'
import { registerSystemProxyInstallCaCommand } from './install-ca.js'
import { registerSystemProxyCaTrustStateCommand } from './ca-trust-state.js'
import { registerSystemProxyStartCommand } from './start.js'
import { registerSystemProxyStopCommand } from './stop.js'
import { registerSystemProxyStatusCommand } from './status.js'

export function registerSystemProxyCommands(program: Command): void {
  const systemProxyCmd = program
    .command('system-proxy')
    .description('Local System Proxy for routing configured tools through Antseed')

  registerSystemProxyInstallCaCommand(systemProxyCmd)
  registerSystemProxyCaTrustStateCommand(systemProxyCmd)
  registerSystemProxyStartCommand(systemProxyCmd)
  registerSystemProxyStopCommand(systemProxyCmd)
  registerSystemProxyStatusCommand(systemProxyCmd)
}
