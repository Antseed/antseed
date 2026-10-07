import { join } from 'node:path'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { getGlobalOptions } from '../types.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { CAManager } from '../../../system-proxy/ca-manager.js'
import { CertCache } from '../../../system-proxy/cert-cache.js'
import { SystemProxyServer } from '../../../system-proxy/proxy-server.js'
import { resolveProxiedDomains, resolveProxiedPathPrefixes, resolveSystemProxyForwardRules, resolveSystemProxySources, CONFIGURED_PROFILES } from '../../../system-proxy/profiles.js'
import { writeNodeProxyHook } from '../../../system-proxy/node-hook.js'
import type { SystemProxySnapshot } from '../../../system-proxy/system-proxy.js'
import { proxyAuthHeaders } from '../../../proxy/proxy-auth.js'

const DEFAULT_SYSTEM_PROXY_PORT = 8378
const DEFAULT_BUYER_PORT = 8377

function systemProxyDir(dataDir: string): string { return join(dataDir, 'system-proxy') }
function pidFile(dataDir: string): string { return join(systemProxyDir(dataDir), 'system-proxy.pid') }
function stateFile(dataDir: string): string { return join(systemProxyDir(dataDir), 'system-proxy.state.json') }
function proxySnapshotFile(dataDir: string): string { return join(systemProxyDir(dataDir), 'system-proxy.snapshot.json') }

function collectValues(val: string, prev: string[]): string[] {
  return [...prev, val]
}

export function registerSystemProxyStartCommand(cmd: Command): void {
  cmd
    .command('start')
    .description('Start the local System Proxy')
    .requiredOption('--peer <peerId>', 'Peer ID to route proxied requests through (peer@model routing)')
    .option('--default-model <model>', 'Model/service to use when a proxied request asks for auto or an unsupported model')
    .option('--served-model <model>', 'Model/service served by the selected peer (repeatable; enables unsupported-model fallback)', collectValues, [] as string[])
    .option('--port <number>', 'Port for the System Proxy', String(DEFAULT_SYSTEM_PROXY_PORT))
    .option('--buyer-port <number>', 'Local buyer proxy port', String(DEFAULT_BUYER_PORT))
    .option(
      '--profile <name>',
      'Profile to activate from local System Proxy config (repeatable, default: all configured profiles)',
      collectValues,
      [] as string[],
    )
    .option('--system-proxy', 'Set OS HTTPS proxy to this System Proxy port (macOS/Windows)', false)
    .action(async (options: {
      peer: string
      port: string
      buyerPort: string
      profile: string[]
      systemProxy: boolean
      defaultModel?: string
      servedModel: string[]
    }) => {
      const globalOpts = getGlobalOptions(cmd)
      const dataDir = globalOpts.dataDir
      const port = parseInt(options.port, 10) || DEFAULT_SYSTEM_PROXY_PORT
      const buyerPort = parseInt(options.buyerPort, 10) || DEFAULT_BUYER_PORT
      const profileNames = options.profile.length > 0
        ? options.profile
        : CONFIGURED_PROFILES.map((p) => p.name)
      const peerId = options.peer
      const defaultModel = options.defaultModel?.trim() || undefined
      const servedModels = new Set(options.servedModel.map((model) => model.trim()).filter(Boolean))

      const caManager = new CAManager(dataDir)

      if (profileNames.length === 0) {
        console.error(chalk.red('No System Proxy profiles configured.'))
        console.error(chalk.dim('Set ANTSEED_SYSTEM_PROXY_PROFILES_JSON or ANTSEED_SYSTEM_PROXY_PROFILES_FILE before starting System Proxy.'))
        process.exit(1)
      }

      if (!(await caManager.exists())) {
        const genSpinner = ora('Generating CA certificate (first run)...').start()
        await caManager.generate()
        genSpinner.succeed(chalk.green('CA certificate generated'))
        console.log('')
        console.log(chalk.yellow('ACTION REQUIRED — install the CA so your browser/tools trust it:'))
        console.log(`  antseed system-proxy install-ca`)
        console.log('')
        console.log(chalk.yellow('For Node.js tools set:'))
        console.log(`  export NODE_EXTRA_CA_CERTS="${caManager.certFilePath}"`)
        console.log('')
      }

      const caKeys = await caManager.load()
      const certCache = new CertCache(caKeys)
      const proxiedDomains = resolveProxiedDomains(profileNames)
      const proxiedPathPrefixes = resolveProxiedPathPrefixes(profileNames)
      const proxiedSources = resolveSystemProxySources(profileNames)
      const systemProxyForwardRules = resolveSystemProxyForwardRules(profileNames)

      if (proxiedDomains.size === 0) {
        console.error(chalk.red(`No valid profiles found: ${profileNames.join(', ')}`))
        process.exit(1)
      }

      console.log(chalk.bold('System Proxy configuration:'))
      console.log(chalk.dim(`  peer:     ${peerId}`))
      if (defaultModel) {
        console.log(chalk.dim(`  default:  ${defaultModel}`))
      }
      console.log(chalk.dim(`  port:     ${port}`))
      console.log(chalk.dim(`  profiles: ${profileNames.join(', ')}`))
      console.log('')

      const proxy = new SystemProxyServer({
        port,
        buyerProxyPort: buyerPort,
        buyerAuthHeaders: () => proxyAuthHeaders(dataDir, buyerPort),
        certCache,
        proxiedDomains,
        proxiedPathPrefixes,
        proxiedSources,
        systemProxyForwardRules,
        defaultPeerId: peerId,
        defaultModel,
        servedModels,
      })

      const proxySpinner = ora(`Starting System Proxy on port ${port}...`).start()
      try {
        await proxy.start()
        proxySpinner.succeed(chalk.green(`System Proxy listening on http://localhost:${port}`))
      } catch (err) {
        proxySpinner.fail(chalk.red(`Failed to start System Proxy: ${(err as Error).message}`))
        process.exit(1)
      }

      await mkdir(systemProxyDir(dataDir), { recursive: true })
      let proxySnapshot: SystemProxySnapshot | null = null
      if (options.systemProxy) {
        try {
          const { setSystemProxy } = await import('../../../system-proxy/system-proxy.js')
          proxySnapshot = setSystemProxy({ host: '127.0.0.1', port })
          await writeFile(proxySnapshotFile(dataDir), JSON.stringify(proxySnapshot), 'utf8')
          console.log(chalk.dim(`System HTTPS proxy set to 127.0.0.1:${port}`))
        } catch (err) {
          console.log(chalk.yellow(`Could not set system proxy: ${(err as Error).message}`))
        }
      }

      await writeFile(pidFile(dataDir), String(process.pid), 'utf8')
      await writeFile(
        stateFile(dataDir),
        JSON.stringify({ port, peerId, defaultModel, activeProfileNames: profileNames, running: true }),
        'utf8',
      )

      // Generate the Node.js proxy hook (makes undici/fetch respect the proxy)
      const hookFile = await writeNodeProxyHook(dataDir, port)

      console.log('')
      console.log(chalk.bold('Open a new terminal and set these env vars (one-time per session):'))
      console.log(`  export HTTPS_PROXY=http://localhost:${port}`)
      console.log(`  export NODE_EXTRA_CA_CERTS="${caManager.certFilePath}"`)
      console.log(`  export NODE_OPTIONS="--require ${hookFile}"`)
      console.log('')
      console.log(chalk.dim('The last line makes Node.js tools route through the proxy.'))
      console.log('')

      setupShutdownHandler(async () => {
        await proxy.stop()
        if (options.systemProxy) {
          try {
            const { restoreSystemProxySnapshot, clearSystemProxy } = await import('../../../system-proxy/system-proxy.js')
            if (proxySnapshot) restoreSystemProxySnapshot(proxySnapshot)
            else clearSystemProxy({ host: '127.0.0.1', port })
          } catch { /* best-effort */ }
        }
        try { await unlink(pidFile(dataDir)) } catch { /* already gone */ }
        try { await unlink(stateFile(dataDir)) } catch { /* already gone */ }
        try { await unlink(proxySnapshotFile(dataDir)) } catch { /* already gone */ }
        console.log(chalk.dim('System Proxy stopped.'))
      })
    })
}
