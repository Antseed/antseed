import type { Command } from 'commander'
import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import {
  loadCryptoContext,
  createDepositsClient,
  createDepositRelayClient,
  requireCryptoConfig,
  formatUsdc,
  parseUsdcToBaseUnits,
} from '../../payment-utils.js'
import { AntseedNode, buildReceiveAuthorization, makeUsdcDomain, peerRelaysSweeps } from '@antseed/node'
import type { DepositRelayClient, DepositsClient, SweepRequestPayload, SweepReceiptPayload } from '@antseed/node'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { buildBuyerBootstrapEntries } from './start.js'
import { daemonFetch, type BuyerDaemonTarget } from './daemon.js'

const AUTH_VALIDITY_SECS = 3600
const POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_SECS = 120
const MAX_PEERS_TO_CONNECT = 4
/** Deposits contract default MIN_BUYER_DEPOSIT (1 USDC); pre-flight only —
 *  relayers simulate against the live value before submitting. */
const DEFAULT_MIN_BUYER_DEPOSIT = 1_000_000n

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseTimeoutSecs(value: string | undefined): { value: number; usedDefault: boolean } {
  if (!value) return { value: DEFAULT_TIMEOUT_SECS, usedDefault: false }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: DEFAULT_TIMEOUT_SECS, usedDefault: true }
  }
  return { value: Math.floor(parsed), usedDefault: false }
}

// ─── Running-daemon control plane ─────────────────────────────────────

/** POST the signed payload to the daemon, which offers it to relayers one at
 *  a time. Returns the peers-offered count, or null when no daemon is
 *  reachable on the proxy port. The generous timeout covers the daemon's
 *  sequential offer round (~10s per candidate relayer). */
async function daemonBroadcast(
  daemon: BuyerDaemonTarget,
  payload: SweepRequestPayload,
): Promise<{ sent: number; accepted?: boolean } | null> {
  const res = await daemonFetch(daemon, '/_antseed/sweep', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 90_000)
  if (!res) return null
  const body = await res.json().catch(() => null) as { ok?: boolean; sent?: number; accepted?: boolean; error?: string } | null
  if (!res.ok || !body?.ok || typeof body.sent !== 'number') {
    throw new Error(`Daemon rejected the sweep request: ${body?.error ?? `HTTP ${res.status}`}`)
  }
  // `accepted` is undefined when an older daemon predates sequential dispatch.
  return { sent: body.sent, ...(typeof body.accepted === 'boolean' ? { accepted: body.accepted } : {}) }
}

/** Ask the daemon to refresh discovery and eagerly connect to a few sellers. */
async function daemonRefreshAndConnect(daemon: BuyerDaemonTarget): Promise<void> {
  await daemonFetch(daemon, '/_antseed/peers/refresh', { method: 'POST' }, 30_000)
  const res = await daemonFetch(daemon, '/_antseed/peers')
  const body = await res?.json().catch(() => null) as {
    peers?: Array<{ peerId: string; capabilities?: string[]; metadata?: { capabilities?: string[] } }>
  } | null
  const peers = (body?.peers ?? []).filter(peerRelaysSweeps)
  await Promise.allSettled(
    peers.slice(0, MAX_PEERS_TO_CONNECT).map((p) =>
      daemonFetch(daemon, '/_antseed/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peerId: p.peerId }),
      }, 20_000),
    ),
  )
}

async function daemonGetReceipt(daemon: BuyerDaemonTarget, nonce: string): Promise<SweepReceiptPayload | null> {
  const res = await daemonFetch(daemon, `/_antseed/sweep/${nonce}`, undefined, 3000)
  const body = await res?.json().catch(() => null) as { receipt?: SweepReceiptPayload | null } | null
  return body?.receipt ?? null
}

// ─── Shared completion polling ────────────────────────────────────────

interface WaitResult {
  credited: bigint | null
  finalAvailable: bigint
  finalTotal: bigint
  confirmation: 'relay-event' | 'authorization' | 'balance' | null
  blockNumber?: number
  relayer?: string
  txHash?: string
}

async function waitForDeposit(
  spinner: Ora,
  depositsClient: DepositsClient,
  relayClient: DepositRelayClient,
  address: string,
  initialAvailable: bigint,
  initialTotal: bigint,
  expectedNet: bigint,
  fee: bigint,
  usdcAddress: string,
  authNonce: string,
  timeoutSecs: number,
  getReceipt: () => Promise<SweepReceiptPayload | null>,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutSecs * 1000
  let txHash: string | undefined

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    const receipt = await getReceipt().catch(() => null)
    if (receipt) {
      if (receipt.txHash) txHash = receipt.txHash
      if (receipt.status === 'submitted') {
        spinner.text = 'Relayer accepted the sweep — submitting on-chain...'
      } else if (receipt.status === 'confirmed') {
        spinner.text = 'Sweep transaction reported — verifying relay event...'
      }
    }

    const current = await depositsClient.getBuyerBalance(address).catch(() => null)
    const finalAvailable = current?.available ?? initialAvailable
    const finalTotal = current ? current.available + current.reserved : initialTotal

    if (txHash) {
      const confirmation = await relayClient.getSweepConfirmation(txHash, {
        buyer: address,
        deposited: expectedNet,
        fee,
        authNonce,
      }).catch(() => null)
      if (confirmation) {
        return {
          credited: confirmation.deposited,
          finalAvailable,
          finalTotal: current ? finalTotal : initialTotal + confirmation.deposited,
          confirmation: 'relay-event',
          blockNumber: confirmation.blockNumber,
          relayer: confirmation.relayer,
          txHash: confirmation.txHash,
        }
      }
    }

    const authorizationUsed = await relayClient.isAuthorizationUsed(usdcAddress, address, authNonce).catch(() => false)
    if (authorizationUsed) {
      return {
        credited: expectedNet,
        finalAvailable,
        finalTotal: current ? finalTotal : initialTotal + expectedNet,
        confirmation: 'authorization',
        ...(txHash ? { txHash } : {}),
      }
    }

    if (finalTotal >= initialTotal + expectedNet) {
      return {
        credited: finalTotal - initialTotal,
        finalAvailable,
        finalTotal,
        confirmation: 'balance',
        ...(txHash ? { txHash } : {}),
      }
    }
  }
  return {
    credited: null,
    finalAvailable: initialAvailable,
    finalTotal: initialTotal,
    confirmation: null,
    ...(txHash ? { txHash } : {}),
  }
}

export function registerBuyerSweepCommand(buyerCmd: Command): void {
  buyerCmd
    .command('sweep')
    .description('Gaslessly sweep hot-wallet USDC into your deposits balance via permissionless relayers (fixed fee paid in USDC)')
    .option('--amount <usdc>', 'Amount to sweep in human-readable USDC (default: full hot-wallet balance)')
    .option('--timeout <secs>', `Seconds to wait for the deposit to land (default: ${DEFAULT_TIMEOUT_SECS})`)
    .action(async (options: { amount?: string; timeout?: string }) => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const config = await loadConfig(globalOpts.config)

      let node: AntseedNode | null = null
      try {
        const crypto = requireCryptoConfig(config)
        if (!crypto.depositRelayAddress) {
          console.error(chalk.red('Error: No deposit relay deployed for this chain.'))
          console.error(chalk.dim('Set payments.crypto.depositRelayAddress in your config file.'))
          process.exit(1)
        }

        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir)
        const depositsClient = createDepositsClient(config)
        const relayClient = createDepositRelayClient(config)

        console.log(chalk.dim(`Wallet: ${address}`))

        const balanceSpinner = ora('Checking hot-wallet USDC balance...').start()
        const [usdcBalance, initialDeposits, creditLimit, fee] = await Promise.all([
          depositsClient.getUSDCBalance(address),
          depositsClient.getBuyerBalance(address),
          depositsClient.getBuyerCreditLimit(address),
          relayClient.fee(),
        ])
        balanceSpinner.succeed(`Hot wallet holds ${formatUsdc(usdcBalance)} USDC — relay fee is fixed at ${formatUsdc(fee)} USDC`)

        // Deposits caps the credited balance at the buyer's credit limit;
        // the sweep would revert whole if the net pushed past it.
        const depositsBalance = initialDeposits.available + initialDeposits.reserved
        const headroom = creditLimit > depositsBalance ? creditLimit - depositsBalance : 0n
        if (headroom === 0n) {
          console.error(chalk.red(`Error: Your deposits balance is at its credit limit (${formatUsdc(creditLimit)} USDC).`))
          console.error(chalk.dim('Spend or withdraw before sweeping more.'))
          process.exit(1)
        }

        let amount = options.amount ? parseUsdcToBaseUnits(options.amount) : usdcBalance
        if (amount === 0n) {
          console.error(chalk.red('Error: No USDC to sweep.'))
          process.exit(1)
        }
        if (amount > usdcBalance) {
          console.error(chalk.red(`Error: Amount exceeds hot-wallet balance (${formatUsdc(usdcBalance)} USDC).`))
          process.exit(1)
        }
        if (amount <= fee) {
          console.error(chalk.red(`Error: Amount must exceed the fixed relay fee (${formatUsdc(fee)} USDC).`))
          process.exit(1)
        }
        if (amount - fee > headroom) {
          const maxSweep = headroom + fee
          if (options.amount) {
            console.error(chalk.red(`Error: Net amount exceeds your credit-limit headroom (${formatUsdc(headroom)} USDC).`))
            console.error(chalk.dim(`Maximum sweep right now: ${formatUsdc(maxSweep)} USDC (limit ${formatUsdc(creditLimit)} USDC, deposited ${formatUsdc(depositsBalance)} USDC).`))
            process.exit(1)
          }
          amount = maxSweep
          console.log(chalk.yellow(`Sweeping ${formatUsdc(amount)} USDC (clamped to credit-limit headroom; ${formatUsdc(usdcBalance - amount)} USDC stays in the hot wallet).`))
        }

        const isFirstDeposit = depositsBalance === 0n
        if (isFirstDeposit && amount - fee < DEFAULT_MIN_BUYER_DEPOSIT) {
          console.error(chalk.red(`Error: First deposit must net at least ${formatUsdc(DEFAULT_MIN_BUYER_DEPOSIT)} USDC after the ${formatUsdc(fee)} USDC fee.`))
          process.exit(1)
        }

        // Guard against a wrong USDC domain (name/version differ per deployment):
        // a mismatch here would produce signatures the token silently rejects.
        const usdcDomain = makeUsdcDomain(crypto.evmChainId, crypto.usdcContractAddress)
        const domainOk = await relayClient.verifyUsdcDomain(crypto.usdcContractAddress, usdcDomain)
        if (!domainOk) {
          console.error(chalk.red('Error: USDC EIP-712 domain mismatch — refusing to sign.'))
          console.error(chalk.dim('The deployed token does not match the expected "USD Coin"/"2" domain.'))
          process.exit(1)
        }

        const signSpinner = ora('Signing sweep authorization (offline)...').start()
        const nowSecs = Math.floor(Date.now() / 1000)
        const validAfter = nowSecs - 60
        const validBefore = nowSecs + AUTH_VALIDITY_SECS
        // The single EIP-3009 signature, addressed to the relay contract, is
        // the consent to its immutable fixed FEE — no second signature.
        const { message, signature: sig3009 } = await buildReceiveAuthorization(wallet, usdcDomain, {
          to: crypto.depositRelayAddress,
          value: amount,
          validAfter: BigInt(validAfter),
          validBefore: BigInt(validBefore),
        })
        signSpinner.succeed(`Signed sweep of ${formatUsdc(amount)} USDC (fixed fee ${formatUsdc(fee)} USDC)`)

        const payload: SweepRequestPayload = {
          version: 1,
          evmChainId: crypto.evmChainId,
          relayAddress: crypto.depositRelayAddress,
          from: address,
          amount: amount.toString(),
          validAfter,
          validBefore,
          nonce: message.nonce,
          sig3009,
        }

        // Prefer the running buyer daemon: it already holds authenticated
        // seller connections, and a second node with the same identity would
        // collide with the daemon's peerId on the network.
        const proxyPort = config.buyer.proxyPort
        const netSpinner = ora(`Checking for a running buyer daemon on port ${proxyPort}...`).start()
        const daemon = { port: proxyPort, dataDir: globalOpts.dataDir }
        let dispatchResult = await daemonBroadcast(daemon, payload)
        let getReceipt: () => Promise<SweepReceiptPayload | null>
        let sent: number

        if (dispatchResult !== null) {
          if (dispatchResult.sent === 0) {
            netSpinner.text = 'Daemon has no connected sweep relayers — refreshing discovery...'
            await daemonRefreshAndConnect(daemon)
            dispatchResult = await daemonBroadcast(daemon, payload) ?? { sent: 0 }
          }
          sent = dispatchResult.sent
          if (sent === 0) {
            netSpinner.fail(chalk.red('Buyer daemon is running but could not reach any sweep relayers.'))
            console.log(chalk.dim('Your funds have not moved — check the daemon\'s network connectivity and retry.'))
            process.exit(1)
          }
          // accepted === false means every relayer in the round declined (or
          // stayed silent) — fail fast instead of waiting out the full
          // confirmation window. undefined (older daemon) falls through.
          if (dispatchResult.accepted === false) {
            netSpinner.fail(chalk.red(`No relayer accepted the sweep (offered to ${sent} peer${sent === 1 ? '' : 's'}).`))
            console.log(chalk.dim('Your funds have not moved — relayers may be at capacity or unprofitable at this amount. Retry shortly.'))
            process.exit(1)
          }
          netSpinner.text = `Broadcast via running daemon to ${sent} peer${sent === 1 ? '' : 's'} — waiting for a relayer...`
          getReceipt = () => daemonGetReceipt(daemon, message.nonce)
        } else {
          // Fallback: no daemon — join the network with an ephemeral node.
          netSpinner.text = 'No running daemon — connecting to P2P network directly...'
          const bootstrapNodes = toBootstrapConfig(
            parseBootstrapList(buildBuyerBootstrapEntries(config.network?.bootstrapNodes)),
          )
          node = new AntseedNode({
            role: 'buyer',
            bootstrapNodes,
            allowPrivateIPs: true,
            dataDir: globalOpts.dataDir,
          })
          await node.start()

          const peers = (await node.discoverPeers()).filter(peerRelaysSweeps)
          if (peers.length === 0) {
            netSpinner.fail(chalk.red('No sweep relayers found on the network. Your funds have not moved — try again later.'))
            process.exit(1)
          }
          await Promise.allSettled(peers.slice(0, MAX_PEERS_TO_CONNECT).map((peer) => node!.connectToPeer(peer)))

          let latestReceipt: SweepReceiptPayload | null = null
          node.on('sweep:receipt', (event: { peerId: string; payload: SweepReceiptPayload }) => {
            if (event.payload.authNonce === message.nonce) latestReceipt = event.payload
          })
          getReceipt = async () => latestReceipt

          netSpinner.text = 'Offering sweep request to relayers one at a time...'
          const dispatch = await node.dispatchSweepRequest(payload)
          sent = dispatch.offered
          if (sent === 0) {
            netSpinner.fail(chalk.red('Could not reach any peers. Your funds have not moved — try again later.'))
            process.exit(1)
          }
          netSpinner.text = dispatch.accepted
            ? 'A relayer accepted the sweep — waiting for on-chain confirmation...'
            : `Offered to ${sent} peer${sent === 1 ? '' : 's'} with no acceptance yet — watching for confirmation...`
        }

        const timeout = parseTimeoutSecs(options.timeout)
        if (timeout.usedDefault) {
          console.log(chalk.yellow(`Ignoring invalid --timeout value; using ${DEFAULT_TIMEOUT_SECS}s.`))
        }
        const result = await waitForDeposit(
          netSpinner,
          depositsClient,
          relayClient,
          address,
          initialDeposits.available,
          depositsBalance,
          amount - fee,
          fee,
          crypto.usdcContractAddress,
          message.nonce,
          timeout.value,
          getReceipt,
        )

        if (result.credited !== null) {
          const confirmationLabel = result.confirmation === 'relay-event'
            ? 'verified relay event'
            : result.confirmation === 'authorization'
              ? 'verified USDC authorization'
              : 'verified deposits balance'
          netSpinner.succeed(chalk.green(`Sweep confirmed by ${confirmationLabel}: deposited ${formatUsdc(result.credited)} USDC`))
          console.log(chalk.dim(`New available balance: ${formatUsdc(result.finalAvailable)} USDC`))
          console.log(chalk.dim(`New deposits total: ${formatUsdc(result.finalTotal)} USDC`))
          if (result.txHash) console.log(chalk.dim(`Transaction: ${result.txHash}`))
          if (result.blockNumber !== undefined) console.log(chalk.dim(`Block: ${result.blockNumber}`))
          if (result.relayer) console.log(chalk.dim(`Relayer: ${result.relayer}`))
          if (node) await node.stop()
          process.exit(0)
        }

        netSpinner.fail(chalk.yellow(`No on-chain sweep confirmation within ${timeout.value}s.`))
        console.log(chalk.dim('No matching relay event, consumed authorization, or deposits-balance increase was observed.'))
        console.log(chalk.dim('Retrying may deposit twice if the first sweep lands late; both deposits credit this same buyer wallet.'))
        console.log(chalk.dim(`The signed authorization expires at ${new Date(validBefore * 1000).toISOString()}.`))
        if (result.txHash) console.log(chalk.dim(`Last seen transaction: ${result.txHash}`))
        if (node) await node.stop()
        process.exit(1)
      } catch (err) {
        console.error(chalk.red(`Sweep failed: ${(err as Error).message}`))
        if (node) await node.stop().catch(() => {})
        process.exit(1)
      }
    })
}
