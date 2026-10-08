import type { Command } from 'commander'
import chalk from 'chalk'
import { createConsoleAuth } from '../../../gateway/auth/index.js'
import { consoleBaseUrl, normalizePublicUrl, readConsoleLocation, type ConsoleLocation } from '../../../gateway/console.js'
import { activeOwners, createRecoveryLink } from '../../../gateway/console-recovery.js'
import type { GatewayStore, MemberRecord } from '../../../gateway/store.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { DEFAULT_GATEWAY_PORT, openGatewayStore, printJson } from './shared.js'

export interface ConsoleLocationOptions {
  publicUrl?: string
  port?: number
}

/** Adds `--public-url` and `--port`, for commands that print console links. */
export function addConsoleLocationOptions(cmd: Command): Command {
  return cmd
    .option('--public-url <url>', 'console origin to use in links (default: what the running gateway uses, else env ANTSEED_GATEWAY_PUBLIC_URL)')
    .option('--port <number>', `gateway port for localhost links (default: the running gateway's, else ${DEFAULT_GATEWAY_PORT})`, parsePositiveInteger)
}

/**
 * Where links should point: flags, then what the last gateway start saved,
 * then ANTSEED_GATEWAY_PUBLIC_URL, then localhost on the default port.
 */
export function resolveConsoleLocation(store: GatewayStore, options: ConsoleLocationOptions, env: NodeJS.ProcessEnv = process.env): ConsoleLocation {
  const saved = readConsoleLocation(store)
  const publicUrl = normalizePublicUrl(options.publicUrl)
    ?? saved?.publicUrl
    ?? normalizePublicUrl(env['ANTSEED_GATEWAY_PUBLIC_URL'])
  return { publicUrl: publicUrl ?? null, port: options.port ?? saved?.port ?? DEFAULT_GATEWAY_PORT }
}

/** A fresh single-use setup link while the console has no owner; null once it has one. */
export function createSetupLink(store: GatewayStore, location: ConsoleLocation): string | null {
  const auth = createConsoleAuth(
    { store, publicUrl: location.publicUrl, now: () => Date.now(), log: () => undefined, gatewayPort: location.port },
    { env: {} },
  )
  return auth.authConfig().setupRequired ? auth.createSetupLink() : null
}

/** The member `--recover` targets: `--member` (id or email), else the only active owner. */
export function recoveryTarget(store: GatewayStore, member: string | undefined): MemberRecord {
  if (member) {
    const wanted = member.trim()
    const found = store.getMember(wanted) ?? store.findMemberByEmail(wanted.toLowerCase())
    if (!found || found.status !== 'active') throw new Error(`No active member "${wanted}". List them with \`antseed gateway member list\`.`)
    return found
  }
  const owners = activeOwners(store)
  if (owners.length === 0) throw new Error('The console has no owner yet; run `antseed gateway console-link` for a setup link instead.')
  if (owners.length > 1) {
    throw new Error(`The console has ${owners.length} owners; pick one with --member <id|email> (${owners.map((owner) => owner.email ?? owner.id).join(', ')}).`)
  }
  return owners[0]!
}

function printRecoveryLink(store: GatewayStore, location: ConsoleLocation, url: string, options: { json: boolean; member?: string }): void {
  if (!store.isSetupComplete()) throw new Error('The console has no owner yet; run `antseed gateway console-link` (without --recover) for a setup link.')
  const link = createRecoveryLink(store, location, recoveryTarget(store, options.member).id)
  if (options.json) {
    printJson({ url, recoveryLink: link.url, memberId: link.member.id, expiresAt: new Date(link.expiresAt).toISOString() })
    return
  }
  console.log(`${chalk.bold('Recovery link')} for ${link.member.label}${link.member.email ? ` <${link.member.email}>` : ''} (single use, valid for 1 hour):`)
  console.log(`  ${link.url}`)
  console.log(chalk.dim('Open it in a browser to add a passkey, wallet or SSO sign-in for this member. Running this again replaces the link.'))
  console.log(chalk.dim('It is recorded in the audit log. Anyone holding it can sign in as this member until it is used: share it only with them.'))
}

export function registerGatewayConsoleLinkCommand(gateway: Command): void {
  addConsoleLocationOptions(
    gateway.command('console-link')
      .description('Print a one-time owner setup link for the gateway console, or its URL once it has an owner (--recover: a one-time recovery link for an existing member)'),
  )
    .option('--recover', 'once the console has an owner: print a one-time recovery link that lets an existing member add a sign-in method (e.g. after moving to a new domain)', false)
    .option('--member <id|email>', 'with --recover: the member to recover (default: the owner)')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: ConsoleLocationOptions & { json: boolean; recover: boolean; member?: string }) => {
      const { store } = openGatewayStore(gateway)
      try {
        const location = resolveConsoleLocation(store, options)
        const url = `${consoleBaseUrl(location)}/console`
        if (options.recover) {
          printRecoveryLink(store, location, url, options)
          return
        }
        const setupLink = createSetupLink(store, location)
        if (options.json) {
          printJson({ url, setupRequired: setupLink !== null, setupLink })
          return
        }
        if (setupLink) {
          console.log(`${chalk.bold('Console setup link')} (single use, valid for 1 hour):`)
          console.log(`  ${setupLink}`)
          console.log(chalk.dim('Open it in a browser to claim the console as its owner. Running this again replaces the link.'))
          if (!location.publicUrl) {
            console.log(chalk.dim(`On a remote server, forward the port first: ssh -N -L ${location.port}:127.0.0.1:${location.port} <user>@<server>`))
          }
          return
        }
        console.log(`${chalk.bold('Console:')} ${url}`)
        console.log(chalk.dim('The console already has an owner. Sign in there; invite people from its Members page or with'))
        console.log(chalk.dim('  antseed gateway member invite --label <name> --email <email>'))
        console.log(chalk.dim('Lost your sign-in (e.g. passkeys after a domain change)? antseed gateway console-link --recover'))
      } finally {
        store.close()
      }
    })
}
