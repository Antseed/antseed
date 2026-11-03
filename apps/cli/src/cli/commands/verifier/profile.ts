import chalk from 'chalk'
import type { Command } from 'commander'
import { getAddress } from 'ethers'
import { validateAuditorProfile, type AuditorProfile } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import { createVerifierClient } from '../../payment-utils.js'
import { resolveAuditorAddress, resolveAuditorSigner } from './auditor-identity.js'
import { getGlobalOptions } from '../types.js'

interface ProfileOptions {
  name?: string
  icon?: string
  url?: string
  auditor?: string
  json?: boolean
  rpcUrl?: string
}

/**
 * The profile to write: each given flag replaces its field and the others keep their current
 * value, since the contract always stores all three. Returns null when no flag was given.
 */
export function nextAuditorProfile(current: AuditorProfile, options: ProfileOptions): AuditorProfile | null {
  if (options.name === undefined && options.icon === undefined && options.url === undefined) return null
  const next = {
    name: options.name ?? current.name,
    iconUri: options.icon ?? current.iconUri,
    url: options.url ?? current.url,
  }
  validateAuditorProfile(next)
  return next
}

export function registerVerifierProfileCommand(verifierCmd: Command): void {
  verifierCmd
    .command('profile')
    .description('Show or set your public KBF auditor profile (name, icon, link) on the KBF audits contract')
    .option('--name <name>', 'display name (at most 64 bytes; "" clears it)')
    .option('--icon <uri>', 'https:// or ipfs:// link to a square image ("" clears it)')
    .option('--url <uri>', 'https:// or ipfs:// website or profile link ("" clears it)')
    .option('--auditor <address>', 'show this auditor\'s profile instead of your own (read-only)')
    .option('--json', 'print the profile as JSON')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options: ProfileOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      const writing = options.name !== undefined || options.icon !== undefined || options.url !== undefined
      if (writing && options.auditor) throw new Error('setting a profile signs as your own auditor; drop --auditor')

      const signer = writing
        ? await resolveAuditorSigner({ config: config.verifier, dataDir: globalOptions.dataDir })
        : null
      const auditor = signer?.address ?? (await resolveAuditorAddress({
        config: config.verifier, dataDir: globalOptions.dataDir, flag: options.auditor,
      })).address
      const current = await verifierClient.auditorProfile(auditor)
      const next = nextAuditorProfile(current, options)

      if (next) {
        if (!(await verifierClient.approvedAuditor(auditor))) {
          throw new Error(`auditor wallet ${auditor} is not approved by the KBF audits contract ${getAddress(verifierClient.contractAddress)}`)
        }
        const transactionHash = await verifierClient.setAuditorProfile(signer!.wallet, next)
        console.log(chalk.green(`Updated the auditor profile of ${auditor} (${transactionHash})`))
      }
      const profile = next ?? current
      if (options.json) {
        console.log(JSON.stringify({ auditor, ...profile }, null, 2))
        return
      }
      console.log(`Auditor: ${auditor}`)
      console.log(`Name: ${profile.name || chalk.dim('(not set)')}`)
      console.log(`Icon: ${profile.iconUri || chalk.dim('(not set)')}`)
      console.log(`Link: ${profile.url || chalk.dim('(not set)')}`)
    })
}
