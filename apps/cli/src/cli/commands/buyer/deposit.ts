import type { Command } from 'commander'
import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import QRCode from 'qrcode'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import type { AntseedConfig } from '../../../config/types.js'
import {
  loadCryptoContext,
  createDepositsClient,
  createDepositRelayClient,
  requireCryptoConfig,
  formatUsdc,
  parseUsdcToBaseUnits,
} from '../../payment-utils.js'
import { AntseedNode, peerRelaysSweeps } from '@antseed/node'
import type { SweepReceiptPayload } from '@antseed/node'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { buildBuyerBootstrapEntries } from './start.js'
import {
  DepositWatcher,
  type DepositWatchEvent,
} from '../../../proxy/deposit-watcher.js'
import { daemonDepositsStatus, daemonSetWatchMode } from './daemon.js'

const DAEMON_STATUS_POLL_MS = 1_000
// The daemon drops `active` after 5 minutes without a re-request.
const DAEMON_ACTIVE_HEARTBEAT_MS = 60_000
const BALANCE_CHECK_INTERVAL_MS = 5_000
const MAX_PEERS_TO_CONNECT = 4
const PAYMENTS_PORT = 3118

export interface DepositCommandOptions {
  amount?: string
  watch: boolean
  onchain?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** EIP-681 payment request: opens a prefilled USDC transfer in mobile wallets. */
function buildPaymentUri(usdcAddress: string, evmChainId: number, address: string, amountBaseUnits: bigint | null): string {
  const base = `ethereum:${usdcAddress}@${evmChainId}/transfer?address=${address}`
  return amountBaseUnits ? `${base}&uint256=${amountBaseUnits.toString()}` : base
}

// ─── Browser-wallet checkout (the retired portal's pay page) ───

interface WebCheckout {
  url: string
  /** True once the pay page reports the deposit transaction completed. */
  completed: () => boolean
}

/**
 * Serve the connected-wallet deposit page for the duration of the watch, for
 * users who prefer funding from a browser-extension wallet over sending to
 * the hot wallet. Returns null when the port is taken (e.g. the desktop app's
 * portal is running) — the QR/address flow works regardless.
 */
async function startWebCheckout(dataDir: string, amountUsdc: string | null): Promise<WebCheckout | null> {
  try {
    const { createServer } = await import('@antseed/payments')
    let done = false
    const rawHex = process.env['ANTSEED_IDENTITY_HEX'] || undefined
    const identityHex = rawHex ? rawHex.replace(/^0x/i, '') : undefined
    const server = await createServer({
      port: PAYMENTS_PORT,
      dataDir,
      identityHex,
      onPaymentCompleted: () => { done = true },
    })
    await server.listen({ port: PAYMENTS_PORT, host: '127.0.0.1' })
    const token = (server as unknown as { bearerToken?: string }).bearerToken ?? ''
    const params = new URLSearchParams()
    if (token) params.set('token', token)
    params.set('page', 'pay')
    params.set('action', 'deposit')
    const amount = Number(amountUsdc)
    if (Number.isFinite(amount) && amount > 0) params.set('amount', String(amount))
    return { url: `http://127.0.0.1:${PAYMENTS_PORT}?${params.toString()}`, completed: () => done }
  } catch {
    return null
  }
}

// ─── Watch rendering ───

/** Render a watcher event onto the spinner; returns true when the flow is done. */
function renderEvent(spinner: Ora, event: DepositWatchEvent): boolean {
  switch (event.phase) {
    case 'received':
      spinner.text = `Received ${formatUsdc(BigInt(event.amountBaseUnits ?? '0'))} USDC in the hot wallet — sweeping into deposits...`
      return false
    case 'sweeping':
      spinner.text = `Sweeping ${formatUsdc(BigInt(event.amountBaseUnits ?? '0'))} USDC into your deposits balance...`
      return false
    case 'deferred':
      spinner.text = 'Deposit deferred: your deposits balance is at its credit limit. Funds stay in the wallet and sweep when headroom frees up.'
      return false
    case 'error':
      spinner.text = `${event.error ?? 'Sweep attempt failed'} (retrying automatically)`
      return false
    case 'credited':
      spinner.succeed(chalk.green(
        `Deposited ${formatUsdc(BigInt(event.amountBaseUnits ?? '0'))} USDC into your credits.`,
      ))
      if (event.txHash) console.log(chalk.dim(`Transaction: ${event.txHash}`))
      return true
  }
}

async function printFinalBalance(config: AntseedConfig, address: string): Promise<void> {
  try {
    const depositsClient = createDepositsClient(config)
    const balance = await depositsClient.getBuyerBalance(address)
    console.log(chalk.dim(`Deposits available: ${formatUsdc(balance.available)} USDC (total ${formatUsdc(balance.available + balance.reserved)} USDC)`))
  } catch {
    // best-effort display only
  }
}

/**
 * Shared completion signals for both watch paths: the browser-wallet pay
 * page reporting success, or the deposits balance rising without a sweep in
 * flight (a connected-wallet deposit credits the contract directly — the hot
 * wallet never moves, so watcher events alone would miss it).
 */
interface WatchContext {
  config: AntseedConfig
  address: string
  web: WebCheckout | null
  depositsTotal: () => Promise<bigint | null>
  initialTotal: bigint | null
}

async function makeWatchContext(config: AntseedConfig, dataDir: string, address: string, amountUsdc: string | null): Promise<WatchContext> {
  const depositsClient = createDepositsClient(config)
  const depositsTotal = async (): Promise<bigint | null> => {
    try {
      const balance = await depositsClient.getBuyerBalance(address)
      return balance.available + balance.reserved
    } catch {
      return null
    }
  }
  const web = await startWebCheckout(dataDir, amountUsdc)
  return { config, address, web, depositsTotal, initialTotal: await depositsTotal() }
}

function printWebCheckoutHint(web: WebCheckout | null): void {
  if (!web) return
  console.log(`  Prefer a browser wallet? Open: ${chalk.bold(web.url)}`)
  console.log(chalk.dim('  (connect MetaMask / Coinbase Wallet / Rabby there — funds go straight into your deposits)'))
  console.log('')
}

/** Non-sweep completion check shared by both watch loops. Returns a success message or null. */
async function checkExternalCompletion(ctx: WatchContext, sweeping: boolean): Promise<string | null> {
  if (ctx.web?.completed()) return 'Deposit completed from the browser wallet.'
  if (ctx.initialTotal === null || sweeping) return null
  const total = await ctx.depositsTotal()
  if (total !== null && total > ctx.initialTotal) {
    return `Deposits balance increased by ${formatUsdc(total - ctx.initialTotal)} USDC.`
  }
  return null
}

/** Watch through the running buyer daemon's watcher (the normal path). */
async function watchViaDaemon(ctx: WatchContext, port: number): Promise<void> {
  await daemonSetWatchMode(port, 'active')
  // discardStdin would put the TTY in raw mode for the whole (long-lived)
  // watch, which stops the terminal from ever delivering SIGINT on Ctrl+C.
  const spinner = ora({
    text: 'Waiting for USDC to arrive (Ctrl+C to stop watching — funds sweep automatically either way)...',
    discardStdin: false,
  }).start()

  let demoted = false
  const demote = (): Promise<unknown> => {
    if (demoted) return Promise.resolve()
    demoted = true
    // Not a hard stop: the daemon keeps a slow background watch, so a
    // transfer that lands after Ctrl+C is still swept automatically.
    return daemonSetWatchMode(port, 'background').catch(() => {})
  }
  process.on('SIGINT', () => {
    spinner.info('Stopped watching. The connection keeps sweeping incoming USDC in the background.')
    // Let the demote request land, but never hang the exit on it.
    setTimeout(() => process.exit(0), 2_000)
    void demote().finally(() => process.exit(0))
  })

  const finish = async (message?: string): Promise<never> => {
    if (message) spinner.succeed(chalk.green(message))
    await demote()
    await printFinalBalance(ctx.config, ctx.address)
    process.exit(0)
  }

  let lastActiveAt = Date.now()
  let lastSeq = 0
  const initial = await daemonDepositsStatus(port)
  if (initial?.status?.lastEvent) lastSeq = initial.status.lastEvent.seq
  let lastBalanceCheckAt = 0

  for (;;) {
    await sleep(DAEMON_STATUS_POLL_MS)
    if (!demoted && Date.now() - lastActiveAt >= DAEMON_ACTIVE_HEARTBEAT_MS) {
      lastActiveAt = Date.now()
      void daemonSetWatchMode(port, 'active').catch(() => {})
    }
    const current = await daemonDepositsStatus(port)
    if (!current) {
      spinner.text = 'Lost contact with the buyer connection — waiting for it to come back...'
      continue
    }
    const event = current.status?.lastEvent
    if (event && event.seq > lastSeq) {
      lastSeq = event.seq
      if (renderEvent(spinner, event)) await finish()
    }
    const sweeping = current.status?.sweepInFlight === true || event?.phase === 'sweeping'
    if (Date.now() - lastBalanceCheckAt > BALANCE_CHECK_INTERVAL_MS) {
      lastBalanceCheckAt = Date.now()
      const message = await checkExternalCompletion(ctx, sweeping)
      if (message) await finish(message)
    }
  }
}

/** No daemon: watch locally and sweep through an ephemeral node. */
async function watchStandalone(
  ctx: WatchContext,
  dataDir: string,
  crypto: ReturnType<typeof requireCryptoConfig> & { depositRelayAddress: string },
): Promise<void> {
  // discardStdin: see watchViaDaemon — raw-mode stdin would swallow Ctrl+C.
  const spinner = ora({ text: 'Waiting for USDC to arrive (Ctrl+C to stop watching)...', discardStdin: false }).start()
  const { config, address } = ctx

  let node: AntseedNode | null = null
  let latestReceipt: SweepReceiptPayload | null = null
  const ensureNode = async (): Promise<AntseedNode> => {
    if (node) return node
    const bootstrapNodes = toBootstrapConfig(
      parseBootstrapList(buildBuyerBootstrapEntries(config.network?.bootstrapNodes)),
    )
    node = new AntseedNode({ role: 'buyer', bootstrapNodes, allowPrivateIPs: true, dataDir })
    await node.start()
    node.on('sweep:receipt', (event: { peerId: string; payload: SweepReceiptPayload }) => {
      latestReceipt = event.payload
    })
    const relayers = (await node.discoverPeers()).filter(peerRelaysSweeps)
    await Promise.allSettled(relayers.slice(0, MAX_PEERS_TO_CONNECT).map((peer) => node!.connectToPeer(peer)))
    return node
  }

  let credited = false
  const watcher = new DepositWatcher({
    wallet: (await loadCryptoContext(dataDir)).wallet,
    address,
    depositsClient: createDepositsClient(config),
    relayClient: createDepositRelayClient(config),
    usdcAddress: crypto.usdcContractAddress,
    evmChainId: crypto.evmChainId,
    depositRelayAddress: crypto.depositRelayAddress,
    dispatch: async (payload) => (await ensureNode()).dispatchSweepRequest(payload),
    connectRelayers: async () => {
      const n = await ensureNode()
      const relayers = (await n.discoverPeers()).filter(peerRelaysSweeps)
      await Promise.allSettled(relayers.slice(0, MAX_PEERS_TO_CONNECT).map((peer) => n.connectToPeer(peer)))
    },
    getReceipt: async (authNonce) =>
      latestReceipt && latestReceipt.authNonce === authNonce ? latestReceipt : null,
    onEvent: (event) => {
      if (renderEvent(spinner, event)) credited = true
    },
    idleIntervalMs: null,
  })

  process.on('SIGINT', () => {
    watcher.stop()
    spinner.info('Stopped watching. Funds already sent stay safe in the hot wallet — run `antseed buyer sweep` to deposit them.')
    // Let the ephemeral node close cleanly, but never hang the exit on it.
    setTimeout(() => process.exit(0), 2_000)
    void (node ? node.stop().catch(() => {}) : Promise.resolve()).then(() => process.exit(0))
  })

  // This process owns the watcher and stops it on exit: no heartbeat needed.
  watcher.promote(null)
  let lastBalanceCheckAt = 0
  let externalMessage: string | null = null
  while (!credited && !externalMessage) {
    await sleep(DAEMON_STATUS_POLL_MS)
    if (Date.now() - lastBalanceCheckAt > BALANCE_CHECK_INTERVAL_MS) {
      lastBalanceCheckAt = Date.now()
      externalMessage = await checkExternalCompletion(ctx, watcher.status().sweepInFlight)
    }
  }
  watcher.stop()
  if (externalMessage) spinner.succeed(chalk.green(externalMessage))
  await printFinalBalance(config, address)
  if (node) await (node as AntseedNode).stop().catch(() => {})
  process.exit(0)
}

// ─── Legacy direct on-chain deposit (hot wallet pays gas) ───

async function depositOnchain(config: AntseedConfig, dataDir: string, amount: string): Promise<void> {
  let amountBaseUnits: bigint
  try {
    amountBaseUnits = parseUsdcToBaseUnits(amount)
  } catch {
    console.error(chalk.red('Error: Amount must be a positive number.'))
    process.exit(1)
  }

  const { wallet, address } = await loadCryptoContext(dataDir)
  const depositsClient = createDepositsClient(config)

  console.log(chalk.dim(`Wallet: ${address}`))
  console.log(chalk.dim(`Amount: ${formatUsdc(amountBaseUnits)} USDC (${amountBaseUnits} base units)`))

  const spinner = ora('Depositing USDC into deposits contract...').start()
  try {
    const txHash = await depositsClient.deposit(wallet, address, amountBaseUnits)
    spinner.succeed(chalk.green(`Deposited ${formatUsdc(amountBaseUnits)} USDC into deposits contract`))
    console.log(chalk.dim(`Transaction: ${txHash}`))
  } catch (err) {
    spinner.fail(chalk.red(`Deposit failed: ${(err as Error).message}`))
    process.exit(1)
  }
}

// ─── Command ───

export async function runDepositAction(cmd: Command, options: DepositCommandOptions): Promise<void> {
  const globalOpts = getGlobalOptions(cmd)
  const config = await loadConfig(globalOpts.config)

  try {
    if (options.onchain) {
      await depositOnchain(config, globalOpts.dataDir, options.onchain)
      return
    }

    const crypto = requireCryptoConfig(config)
    const { address } = await loadCryptoContext(globalOpts.dataDir)
    const amountBaseUnits = options.amount ? parseUsdcToBaseUnits(options.amount) : null
    const uri = buildPaymentUri(crypto.usdcContractAddress, crypto.evmChainId, address, amountBaseUnits)

    console.log('')
    console.log(chalk.bold('Deposit USDC on Base'))
    console.log(chalk.dim('Scan with a mobile wallet, or send USDC to the address below.'))
    console.log('')
    console.log(await QRCode.toString(uri, { type: 'terminal', small: true }))
    console.log(`  Address: ${chalk.bold(address)}`)
    if (amountBaseUnits) console.log(`  Amount:  ${formatUsdc(amountBaseUnits)} USDC`)
    console.log(chalk.yellow('  Only send USDC on the Base network to this address.'))
    console.log(chalk.dim('  Incoming USDC is swept into your deposits balance by the relayer network (fixed ~$0.05 fee, no ETH needed).'))
    console.log('')

    if (!crypto.depositRelayAddress) {
      console.log(chalk.yellow('Automatic deposit is not available on this chain (no deposit relay).'))
      console.log(chalk.dim('After funding, run `antseed buyer deposit --onchain <amount>` (requires ETH for gas).'))
      return
    }

    if (!options.watch) {
      console.log(chalk.dim('Not watching (--no-watch). A running buyer connection sweeps incoming USDC automatically;'))
      console.log(chalk.dim('without one, run `antseed buyer sweep` once the funds arrive.'))
      return
    }

    const ctx = await makeWatchContext(config, globalOpts.dataDir, address, options.amount ?? null)
    printWebCheckoutHint(ctx.web)

    const proxyPort = config.buyer.proxyPort
    const daemon = await daemonDepositsStatus(proxyPort)
    if (daemon?.watcher) {
      await watchViaDaemon(ctx, proxyPort)
    } else if (daemon) {
      // A daemon is running but has no watcher (payments disabled, or it
      // predates deposit watching). An ephemeral node here would collide
      // with the daemon's peerId, so hand off to the manual command.
      console.log(chalk.yellow('The running buyer connection cannot watch deposits (payments disabled or older version).'))
      console.log(chalk.dim('Once the funds arrive, run `antseed buyer sweep` to deposit them.'))
    } else {
      await watchStandalone(ctx, globalOpts.dataDir, { ...crypto, depositRelayAddress: crypto.depositRelayAddress })
    }
  } catch (err) {
    console.error(chalk.red(`Deposit failed: ${(err as Error).message}`))
    process.exit(1)
  }
}

function addDepositOptions(cmd: Command): Command {
  return cmd
    .option('--amount <usdc>', 'Amount to prefill in the QR payment request and browser checkout')
    .option('--no-watch', 'Print the address and QR code without waiting for funds')
    .option('--onchain <usdc>', 'Legacy direct deposit: send <usdc> from the hot wallet on-chain (requires ETH for gas)')
}

export function registerBuyerDepositCommand(buyerCmd: Command): void {
  addDepositOptions(
    buyerCmd
      .command('deposit')
      .description('Show your USDC funding address and QR code — incoming funds deposit into your credits automatically (gasless)'),
  ).action(async (options: DepositCommandOptions) => {
    await runDepositAction(buyerCmd, options)
  })
}

/** Hidden top-level alias: `antseed deposit` → `antseed buyer deposit`. */
export function registerDepositAlias(program: Command): void {
  addDepositOptions(program.command('deposit', { hidden: true }))
    .action(async (options: DepositCommandOptions) => {
      await runDepositAction(program, options)
    })
}
