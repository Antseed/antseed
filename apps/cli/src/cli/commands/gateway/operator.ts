import type { Command } from 'commander'
import chalk from 'chalk'
import { resolveAntsChain, type AntsChainConfig } from '@antseed/ants'
import { chainInfo } from '../../../gateway/console-api/handlers/wallet-mapping.js'
import { recordAudit } from '../../../gateway/services/context.js'
import {
  depositsOperatorReader,
  describeRelation,
  normalizeOperator,
  operatorRelation,
  sameAddress,
  setOperatorCalldata,
  signOperatorAuthorization,
  walletOwnerFromDb,
  type OperatorReader,
} from '../../../gateway/services/operator.js'
import { sameAddress as sameWallet, walletMismatch } from '../../../gateway/services/wallet-address.js'
import { resolveWorkspaceWallet } from '../../../gateway/services/workspaces.js'
import type { WorkspaceRecord } from '../../../gateway/store.js'
import { confirm } from '../ants/shared.js'
import { loadAuthorizingIdentity, runBrowserWalletAuthorization } from '../buyer/set-authorized-wallet.js'
import { printJson, requireWorkspace, withGateway, type CliGateway } from './shared.js'

/** Seams for tests; production uses the defaults. */
export const operatorCliRuntime: {
  resolveChain: (configPath: string) => Promise<AntsChainConfig>
  reader: (chain: AntsChainConfig) => OperatorReader
  confirm: (question: string) => Promise<boolean>
} = {
  resolveChain: (configPath) => resolveAntsChain(configPath),
  reader: depositsOperatorReader,
  confirm,
}

interface Resolved {
  workspace: WorkspaceRecord
  chain: AntsChainConfig
  reader: OperatorReader
  buyer: string
}

async function resolve(gateway: CliGateway, idOrName: string): Promise<Resolved> {
  const workspace = requireWorkspace(gateway.store, idOrName)
  // The running buyer's address for the identity, else the key the buyer would load; never the cached column.
  const resolved = await resolveWorkspaceWallet(gateway.ctx, workspace)
  const buyer = resolved.address ?? (await loadAuthorizingIdentity(gateway.dataDir, workspace.buyerIdentity)).address
  const chain = await operatorCliRuntime.resolveChain(gateway.configPath)
  if (!chain.depositsContractAddress) throw new Error('The deposits contract is not configured for this chain.')
  return { workspace, chain, reader: operatorCliRuntime.reader(chain), buyer }
}

/** The key the buyer loads for the workspace's identity; refused when it is not the wallet the workspace pays from. */
async function signingIdentity(gateway: CliGateway, record: WorkspaceRecord, buyer: string) {
  const identity = await loadAuthorizingIdentity(gateway.dataDir, record.buyerIdentity)
  if (!sameWallet(identity.address, buyer)) throw walletMismatch(record.buyerIdentity, identity.address, buyer)
  return identity
}

function ownerOf(gateway: CliGateway) {
  return (address: string) => walletOwnerFromDb(gateway.store.database, (id) => gateway.store.getMember(id), address)
}

async function requireConfirmation(yes: boolean, lines: string[], question: string): Promise<void> {
  for (const line of lines) console.error(line)
  if (yes) return
  if (!await operatorCliRuntime.confirm(question)) throw new Error('Cancelled; nothing was signed.')
}

function warning(workspace: WorkspaceRecord, operator: string | null): string[] {
  return [
    chalk.red.bold('WARNING: the authorized wallet controls this workspace\'s money.'),
    chalk.red(`  It can withdraw everything ${workspace.name}'s wallet has deposited (the USDC goes to it) and claims its ANTS rewards.`),
    chalk.red('  Once set, only that wallet can hand the role over or clear it: not the gateway, not the org owner, not this CLI.'),
    ...(operator ? [chalk.red(`  Authorizing: ${operator}`)] : []),
  ]
}

export function registerGatewayOperatorCommands(workspace: Command): void {
  const operator = workspace.command('operator')
    .description('A workspace wallet\'s authorized wallet (AntseedDeposits operator): who can withdraw and claim rewards')

  operator.command('show')
    .description('Show the authorized wallet read live from the chain, and whose it is')
    .argument('<workspace>', 'workspace id or name')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrName: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, async (gateway) => {
      const { workspace: record, chain, reader, buyer } = await resolve(gateway, idOrName)
      const current = await reader.operator(buyer)
      const nonce = await reader.nonce(buyer)
      const { relation, owner } = operatorRelation({ buyer, operator: current, viewerMemberId: null, ownerOf: ownerOf(gateway) })
      if (options.json) {
        printJson({
          workspace: record.id, identity: record.buyerIdentity, buyer, operator: current, relation,
          member: owner, nonce: nonce.toString(), depositsContract: chain.depositsContractAddress, chainId: chain.evmChainId,
        })
        return
      }
      console.log(`${chalk.bold(record.name)} ${chalk.dim(record.id)}  identity ${record.buyerIdentity}`)
      console.log(`Workspace wallet:  ${buyer}`)
      console.log(`Authorized wallet: ${current ?? chalk.yellow('not set')}`)
      const line = describeRelation(relation, owner)
      console.log(relation === 'unknown' ? chalk.red(line) : `  ${line}`)
      console.log(chalk.dim(`Operator nonce ${nonce} · AntseedDeposits ${chain.depositsContractAddress} on chain ${chain.evmChainId}`))
      if (relation === 'none') console.log(chalk.dim(`Authorize one: antseed gateway workspace operator authorize ${record.id} <address>  (or --browser)`))
      else if (relation === 'self') console.log(chalk.dim(`Hand it to a personal wallet: antseed gateway workspace operator transfer ${record.id} <address>`))
      else console.log(chalk.dim('Only the authorized wallet itself can transfer or clear it (AntseedDeposits.transferOperator).'))
    }))

  operator.command('authorize')
    .description('Sign the workspace wallet\'s SetOperator authorization for <address> and print it for submission, or open the local wallet page with --browser')
    .argument('<workspace>', 'workspace id or name')
    .argument('[address]', 'the wallet to authorize (it, or any wallet, submits the transaction and pays gas)')
    .option('--browser', 'serve the local wallet page (antseed buyer set-authorized-wallet) for this workspace\'s wallet instead', false)
    .option('--no-open', 'with --browser: print the local URL without opening a browser')
    .option('-y, --yes', 'skip the interactive confirmation', false)
    .option('--json', 'print machine-readable JSON', false)
    .addHelpText('after', '\nThe authorized wallet can withdraw the workspace\'s deposits and claim its rewards, and only it can change or clear the authorization afterwards. Authorization is possible only while none is set.')
    .action((idOrName: string, address: string | undefined, options: { browser: boolean; open: boolean; yes: boolean; json: boolean }, cmd: Command) => withGateway(cmd, async (gateway) => {
      const { workspace: record, chain, reader, buyer } = await resolve(gateway, idOrName)
      const target = { kind: 'workspace', id: record.id, label: record.name }
      if (options.browser) {
        if (address) throw new Error('Pass either an address or --browser: the local page authorizes the wallet you connect there.')
        const current = await reader.operator(buyer)
        if (current) throw new Error(`${record.name} already has an authorized wallet (${current}); only that wallet can transfer or clear it.`)
        await requireConfirmation(options.yes, warning(record, null), `Open the local page to authorize a wallet for ${record.name}? [y/N] `)
        recordAudit(gateway.ctx, gateway.actor, 'wallet.operator_auth.browser', target, { buyerIdentity: record.buyerIdentity, buyer })
        const identity = await signingIdentity(gateway, record, buyer)
        const { createServer } = await import('@antseed/payments')
        const openBrowser = options.open ? (await import('open')).default : undefined
        console.error(chalk.dim('The page listens on 127.0.0.1 only; on a remote host, forward the port (ssh -L) before opening it.'))
        await runBrowserWalletAuthorization({
          dataDir: gateway.dataDir,
          configPath: gateway.configPath,
          createServer,
          ...(identity.identityHex ? { identityHex: identity.identityHex } : {}),
          ...(openBrowser ? { openBrowser } : {}),
          log: (message) => console.error(chalk.dim(message)),
        })
        console.log(chalk.green('Authorized wallet confirmed.'))
        return
      }
      if (!address) throw new Error('Pass the wallet address to authorize, or --browser to connect it on a local page.')
      const operatorAddress = normalizeOperator(address.trim())
      if (!operatorAddress) throw new Error('The address must be a non-zero 0x wallet address.')
      if (sameAddress(operatorAddress, buyer)) throw new Error('That is the workspace wallet itself; use `antseed buyer set-authorized-wallet --self --identity <name>` for that.')
      const owner = ownerOf(gateway)(operatorAddress)
      const lines = warning(record, operatorAddress)
      lines.push(owner
        ? chalk.yellow(`  ${operatorAddress} is the sign-in wallet of member ${owner.label} (${owner.memberId}).`)
        : chalk.red.bold(`  ${operatorAddress} is NOT a sign-in wallet of any member of this gateway. Double-check you control it.`))
      await requireConfirmation(options.yes, lines, `Sign the authorization for ${operatorAddress}? [y/N] `)
      const identity = await signingIdentity(gateway, record, buyer)
      const auth = await signOperatorAuthorization({ wallet: identity.wallet, chain, operator: operatorAddress, reader })
      recordAudit(gateway.ctx, gateway.actor, 'wallet.operator_auth', target, {
        buyerIdentity: record.buyerIdentity, buyer: auth.buyer, operator: auth.operator, nonce: auth.nonce,
      })
      const calldata = setOperatorCalldata(auth.buyer, auth.operator!, auth.nonceValue, auth.signature)
      const explorer = chainInfo(chain).explorerUrl
      const writeUrl = explorer ? `${explorer.replace(/\/+$/, '')}/address/${auth.depositsContract}#writeContract` : null
      if (options.json) {
        printJson({ workspace: record.id, buyer: auth.buyer, operator: auth.operator, nonce: auth.nonce, signature: auth.signature, depositsContract: auth.depositsContract, chainId: auth.chainId, calldata, explorerWriteUrl: writeUrl })
        return
      }
      console.log(chalk.bold('SetOperator authorization signed by the workspace wallet:'))
      console.log(`  contract  ${auth.depositsContract} (chain ${auth.chainId})`)
      console.log(`  buyer     ${auth.buyer}`)
      console.log(`  operator  ${auth.operator}`)
      console.log(`  nonce     ${auth.nonce}`)
      console.log(`  signature ${auth.signature}`)
      console.log(`  calldata  ${calldata}`)
      console.log('Submit it from any wallet on that chain (the sender pays gas), e.g.:')
      console.log(`  cast send ${auth.depositsContract} 'setOperator(address,address,uint256,bytes)' ${auth.buyer} ${auth.operator} ${auth.nonce} ${auth.signature} --rpc-url <rpc> --account <your-account>`)
      if (writeUrl) console.log(`  or the explorer's "Write contract" tab (setOperator): ${writeUrl}`)
      console.log(chalk.dim('Valid once, only while no authorized wallet is set and the operator nonce is still this one.'))
      console.log(chalk.dim(`Check: antseed gateway workspace operator show ${record.id}`))
    }))

  operator.command('transfer')
    .description('When the workspace wallet is its own authorized wallet: hand the role to <address> (the workspace wallet sends the transaction and needs ETH for gas)')
    .argument('<workspace>', 'workspace id or name')
    .argument('[address]', 'the new authorized wallet')
    .option('--clear', 'clear the authorized wallet instead (no one can withdraw or claim until a new one is authorized)', false)
    .option('-y, --yes', 'skip the interactive confirmation', false)
    .action((idOrName: string, address: string | undefined, options: { clear: boolean; yes: boolean }, cmd: Command) => withGateway(cmd, async (gateway) => {
      const { workspace: record, chain, reader, buyer } = await resolve(gateway, idOrName)
      if (options.clear === Boolean(address)) throw new Error('Pass the new address, or --clear.')
      const next = options.clear ? '0x0000000000000000000000000000000000000000' : normalizeOperator(address!.trim())
      if (!next) throw new Error('The address must be a non-zero 0x wallet address.')
      const current = await reader.operator(buyer)
      if (!current) throw new Error(`${record.name} has no authorized wallet; use \`antseed gateway workspace operator authorize\`.`)
      if (!sameAddress(current, buyer)) {
        throw new Error(`${record.name}'s authorized wallet is ${current}. Only that wallet can transfer or clear it (AntseedDeposits.transferOperator from that wallet); the gateway cannot.`)
      }
      const lines = options.clear
        ? [chalk.red.bold('WARNING: clearing leaves nobody able to withdraw or claim rewards until an owner authorizes a wallet again.')]
        : warning(record, next)
      await requireConfirmation(options.yes, lines, options.clear ? `Clear ${record.name}'s authorized wallet? [y/N] ` : `Transfer to ${next}? [y/N] `)
      const identity = await signingIdentity(gateway, record, buyer)
      const { DepositsClient } = await import('@antseed/node')
      const client = new DepositsClient({
        rpcUrl: chain.rpcUrl,
        ...(chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.fallbackRpcUrls } : {}),
        contractAddress: chain.depositsContractAddress!,
        usdcAddress: chain.usdcContractAddress ?? '',
        evmChainId: chain.evmChainId,
      })
      const txHash = await client.transferOperator(identity.wallet, buyer, next)
      recordAudit(gateway.ctx, gateway.actor, 'wallet.operator.transfer', { kind: 'workspace', id: record.id, label: record.name }, {
        buyerIdentity: record.buyerIdentity, buyer, before: current, after: options.clear ? null : next, txHash,
      })
      console.log(chalk.green(options.clear ? 'Authorized wallet cleared.' : `Authorized wallet transferred to ${next}.`))
      console.log(chalk.dim(`Transaction: ${txHash}`))
    }))
}
