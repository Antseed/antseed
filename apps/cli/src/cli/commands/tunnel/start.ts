import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { getGlobalOptions } from '../types.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { startGatewayRuntime, type GatewayRuntime } from '../../../gateway/runtime.js'
import { DEFAULT_GATEWAY_PORT, topupConfig } from '../gateway/shared.js'
import { ensureCloudflared } from '../../../tunnel/cloudflared.js'
import { tunnelDir, tunnelPidFile, tunnelStateFile } from './paths.js'

const DEFAULT_BUYER_PORT = 8377
type TunnelProvider = 'cloudflare' | 'ngrok'

function parseTunnelProvider(value: string): TunnelProvider {
  const provider = value.trim().toLowerCase()
  if (provider === 'cloudflare' || provider === 'ngrok') return provider
  throw new Error('Tunnel provider must be cloudflare or ngrok.')
}

function providerDisplayName(provider: TunnelProvider): string {
  return provider === 'cloudflare' ? 'Cloudflare Tunnel' : 'ngrok'
}

function providerTokenEnvironmentName(provider: TunnelProvider): string {
  return provider === 'cloudflare' ? 'CLOUDFLARED_TUNNEL_TOKEN' : 'NGROK_AUTHTOKEN'
}

function resolveTunnelToken(provider: TunnelProvider): string {
  const providerToken = process.env[providerTokenEnvironmentName(provider)]
  return (process.env['ANTSEED_TUNNEL_TOKEN'] ?? providerToken ?? '').trim()
}

function parsePublicUrl(value: string, provider: TunnelProvider): URL | null {
  if (!value) {
    if (provider === 'cloudflare') {
      throw new Error('ANTSEED_TUNNEL_PUBLIC_URL is required for Cloudflare Tunnel.')
    }
    return null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('ANTSEED_TUNNEL_PUBLIC_URL must be a valid https:// URL.')
  }
  if (url.protocol !== 'https:') {
    throw new Error('ANTSEED_TUNNEL_PUBLIC_URL must be an https:// URL.')
  }
  return url
}

function ngrokArgs(gatewayPort: number, publicUrl: URL | null): string[] {
  return [
    'http',
    `http://127.0.0.1:${gatewayPort}`,
    ...(publicUrl ? ['--url', publicUrl.origin] : []),
    '--pooling-enabled',
    '--log', 'stdout', '--log-format', 'json', '--log-level', 'info',
  ]
}

function waitForProcessStartup(child: ReturnType<typeof spawn>, provider: TunnelProvider): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1500)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${provider} tunnel exited with code ${String(code)}`))
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function findHttpsUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('https://')) return value
  if (!value || typeof value !== 'object') return null
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'url' || key === 'public_url') && typeof nested === 'string' && nested.startsWith('https://')) return nested
    const found = findHttpsUrl(nested)
    if (found) return found
  }
  return null
}

function waitForNgrokUrl(child: ReturnType<typeof spawn>): Promise<URL> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const finish = (error: Error | null, url?: URL) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(url!)
    }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const found = findHttpsUrl(JSON.parse(line))
          if (found) { finish(null, new URL(found)); return }
        } catch { /* wait for the structured startup line */ }
      }
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null) => finish(new Error(`ngrok tunnel exited with code ${String(code)}`))
    const timer = setTimeout(() => finish(new Error('Timed out waiting for ngrok to publish its HTTPS URL.')), 15_000)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function resolveNgrokBinary(): string {
  const configured = process.env['ANTSEED_NGROK_BIN']?.trim()
  if (configured) return configured
  const executable = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok'
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executable)),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok'] : []),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  throw new Error('ngrok CLI was not found. Install ngrok or set ANTSEED_NGROK_BIN.')
}

export function registerTunnelStartCommand(cmd: Command): void {
  cmd
    .command('start')
    .description('Expose the local buyer API through an authenticated HTTPS tunnel')
    .option('--provider <provider>', 'Tunnel provider: cloudflare or ngrok')
    .option('--buyer-port <number>', 'Local buyer proxy port', String(DEFAULT_BUYER_PORT))
    .option('--gateway-port <number>', 'Local authenticated gateway port', String(DEFAULT_GATEWAY_PORT))
    .action(async (options: { provider?: string; buyerPort: string; gatewayPort: string }) => {
      const globalOptions = getGlobalOptions(cmd)
      const dataDir = globalOptions.dataDir
      const buyerPort = parseInt(options.buyerPort, 10) || DEFAULT_BUYER_PORT
      const gatewayPort = parseInt(options.gatewayPort, 10) || DEFAULT_GATEWAY_PORT
      const provider = parseTunnelProvider(options.provider ?? process.env['ANTSEED_TUNNEL_PROVIDER'] ?? 'cloudflare')
      const tunnelToken = resolveTunnelToken(provider)
      const configuredPublicUrl = process.env['ANTSEED_TUNNEL_PUBLIC_URL']?.trim() ?? ''
      const apiKey = process.env['ANTSEED_TUNNEL_API_KEY']?.trim() ?? ''
      if (!tunnelToken) {
        throw new Error(`Set ${providerTokenEnvironmentName(provider)} before starting the tunnel.`)
      }
      let publicUrl = parsePublicUrl(configuredPublicUrl, provider)

      const topup = topupConfig()
      const spinner = ora('Starting authenticated API gateway...').start()
      let gateway: GatewayRuntime
      try {
        gateway = await startGatewayRuntime({
          dataDir,
          configPath: globalOptions.config,
          listenPort: gatewayPort,
          buyerPort,
          environmentApiKey: apiKey || null,
          ...(topup ? { topup } : {}),
          onLog: (message) => process.stderr.write(`[tunnel] ${message}\n`),
        })
      } catch (error) {
        spinner.fail(chalk.red(`Could not start the API gateway: ${errorMessage(error)}`))
        process.exitCode = 1
        return
      }
      let tunnelProcess: ReturnType<typeof spawn> | null = null
      try {
        const binary = provider === 'cloudflare'
          ? await ensureCloudflared(dataDir)
          : resolveNgrokBinary()
        const args = provider === 'cloudflare'
          ? ['tunnel', '--no-autoupdate', 'run']
          : ngrokArgs(gatewayPort, publicUrl)
        const tunnelEnvironment = provider === 'cloudflare'
          ? { TUNNEL_TOKEN: tunnelToken }
          : { NGROK_AUTHTOKEN: tunnelToken }
        tunnelProcess = spawn(binary, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...tunnelEnvironment,
          },
        })
        const ngrokUrlPromise = provider === 'ngrok' ? waitForNgrokUrl(tunnelProcess) : null
        tunnelProcess.stdout?.pipe(process.stdout)
        tunnelProcess.stderr?.pipe(process.stderr)
        if (ngrokUrlPromise) {
          publicUrl = await ngrokUrlPromise
        } else {
          await waitForProcessStartup(tunnelProcess, provider)
        }
      } catch (error) {
        await gateway.stop()
        spinner.fail(chalk.red(`Could not start ${providerDisplayName(provider)}: ${errorMessage(error)}`))
        process.exitCode = 1
        return
      }

      if (!publicUrl) throw new Error('Tunnel provider did not publish a public URL.')
      const baseUrl = `${publicUrl.toString().replace(/\/+$/, '')}/v1`
      await mkdir(tunnelDir(dataDir), { recursive: true })
      await writeFile(tunnelPidFile(dataDir), String(process.pid), 'utf8')
      await writeFile(tunnelStateFile(dataDir), JSON.stringify({
        running: true,
        pid: process.pid,
        provider,
        buyerPort,
        gatewayPort,
        publicUrl: publicUrl.toString(),
        baseUrl,
        startedAt: Date.now(),
      }), 'utf8')

      spinner.succeed(chalk.green('Public HTTPS tunnel is running'))
      console.log(`${chalk.bold('Base URL:')} ${baseUrl}`)
      console.log(chalk.dim(apiKey
        ? 'Use ANTSEED_TUNNEL_API_KEY or a key from `antseed gateway key create` as the client API key.'
        : 'Use a key from `antseed gateway key create` as the client API key.'))

      setupShutdownHandler(async () => {
        tunnelProcess?.kill('SIGTERM')
        await gateway.stop()
        await unlink(tunnelPidFile(dataDir)).catch(() => undefined)
        await unlink(tunnelStateFile(dataDir)).catch(() => undefined)
        console.log(chalk.dim('Public HTTPS tunnel stopped.'))
      })
    })
}
