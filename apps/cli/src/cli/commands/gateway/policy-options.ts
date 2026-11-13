import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import chalk from 'chalk'
import { isRoutingPolicy, normalizePolicy, type RoutingPolicy, type RoutingSort } from '../../../routing-policy/policy.js'
import { errorMessage } from '../../../gateway/errors.js'
import { findPeerList } from '../../../gateway/services/peer-lists.js'
import type { GatewayStore } from '../../../gateway/store.js'

const SORTS: readonly RoutingSort[] = ['balanced', 'price', 'latency', 'trust']

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/** Adds the routing-policy flags shared by every `… policy set` command. */
export function addPolicyOptions(cmd: Command): Command {
  return cmd
    .option('--file <path>', 'routing policy as JSON (the console\'s RoutingPolicy shape); flags below override its fields')
    .option('--merge', 'start from the current policy at this level instead of replacing it', false)
    .option('--allow-peer <peerId>', 'only these sellers may serve (repeatable)', collect)
    .option('--block-peer <peerId>', 'never route to this seller (repeatable)', collect)
    .option('--allow-list <list>', 'only sellers in this peer list, by id or name (repeatable)', collect)
    .option('--block-list <list>', 'never route to sellers in this peer list (repeatable)', collect)
    .option('--allow-model <model>', 'only these models (repeatable)', collect)
    .option('--min-trust <score>', 'minimum seller trust score, 0-100')
    .option('--min-reputation <score>', 'minimum seller reputation, 0-100')
    .option('--max-input-price <usd>', 'cap on input price, USD per million tokens')
    .option('--max-output-price <usd>', 'cap on output price, USD per million tokens')
    .option('--max-cached-input-price <usd>', 'cap on cached input price, USD per million tokens')
    .option('--require-tee', 'only sellers advertising TEE attestation')
    .option('--require-verified', 'only sellers whose responses pass a verifier')
    .option('--prefer-free', 'rank free sellers first')
    .option('--sort <order>', `how eligible sellers are ranked: ${SORTS.join(', ')}`)
}

/** Adds `--confirm-empty` and `--accept-narrowed`, the CLI side of the console's confirmations. */
export function addConfirmOptions(cmd: Command, narrowing = true): Command {
  cmd.option('--confirm-empty', 'save even if the allow list would leave no seller able to serve', false)
  if (narrowing) cmd.option('--accept-narrowed', 'save even if the levels above allow less than this asks for', false)
  return cmd
}

function score(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${flag} must be a number from 0 to 100.`)
  return value
}

function price(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative USD amount.`)
  return value
}

/** Whether any policy flag (or `--file`) was given. */
export function hasPolicyOptions(options: Record<string, unknown>): boolean {
  return ['file', 'allowPeer', 'blockPeer', 'allowList', 'blockList', 'allowModel', 'minTrust', 'minReputation', 'maxInputPrice',
    'maxOutputPrice', 'maxCachedInputPrice', 'requireTee', 'requireVerified', 'preferFree', 'sort'].some((name) => options[name] !== undefined)
}

/**
 * The policy described by `--file` and the policy flags, on top of `base`
 * when `--merge` is set. Peer lists may be named; they are stored by id.
 * Validated with the same check as the console API.
 */
export function policyFromOptions(store: GatewayStore, options: Record<string, unknown>, base: RoutingPolicy | null = null): RoutingPolicy {
  let policy: Record<string, unknown> = options['merge'] && base ? { ...base } : {}
  if (typeof options['file'] === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(options['file'], 'utf8'))
    } catch (error) {
      throw new Error(`Could not read a JSON policy from ${options['file']}: ${errorMessage(error)}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${options['file']} must hold a JSON object.`)
    policy = { ...policy, ...(parsed as Record<string, unknown>) }
  }
  const list = (name: string): string[] | undefined => options[name] as string[] | undefined
  const peerLists = (names: string[] | undefined) => names?.map((name) => findPeerList({ store }, name).id)
  if (list('allowPeer')) policy['allowedPeerIds'] = list('allowPeer')
  if (list('blockPeer')) policy['blockedPeerIds'] = list('blockPeer')
  if (list('allowList')) policy['allowedPeerLists'] = peerLists(list('allowList'))
  if (list('blockList')) policy['blockedPeerLists'] = peerLists(list('blockList'))
  if (list('allowModel')) policy['allowedModels'] = list('allowModel')
  if (typeof options['minTrust'] === 'string') policy['minTrustScore'] = score(options['minTrust'], '--min-trust')
  if (typeof options['minReputation'] === 'string') policy['minReputation'] = score(options['minReputation'], '--min-reputation')
  if (typeof options['maxInputPrice'] === 'string') policy['maxInputUsdPerMillion'] = price(options['maxInputPrice'], '--max-input-price')
  if (typeof options['maxOutputPrice'] === 'string') policy['maxOutputUsdPerMillion'] = price(options['maxOutputPrice'], '--max-output-price')
  if (typeof options['maxCachedInputPrice'] === 'string') policy['maxCachedInputUsdPerMillion'] = price(options['maxCachedInputPrice'], '--max-cached-input-price')
  if (options['requireTee']) policy['requireTee'] = true
  if (options['requireVerified']) policy['requireVerified'] = true
  if (options['preferFree']) policy['preferFreePeers'] = true
  if (typeof options['sort'] === 'string') {
    if (!SORTS.includes(options['sort'] as RoutingSort)) throw new Error(`--sort must be one of ${SORTS.join(', ')}.`)
    policy['sort'] = options['sort']
  }
  if (!isRoutingPolicy(policy)) throw new Error('That is not a valid routing policy (check peer ids, numbers and field names).')
  return normalizePolicy(policy)
}

/** One line per policy field, for terminal output. */
export function describePolicy(policy: RoutingPolicy | null | undefined, store?: GatewayStore): string[] {
  if (!policy || Object.keys(policy).length === 0) return [chalk.dim('(no restrictions)')]
  const listName = (id: string) => store?.getPeerList(id)?.name ?? id
  const lines: string[] = []
  const add = (label: string, value: unknown) => lines.push(`${label}: ${value}`)
  if (policy.allowedPeerIds) add('Allowed sellers', policy.allowedPeerIds.length ? policy.allowedPeerIds.join(', ') : 'none')
  if (policy.allowedPeerLists) add('Allowed peer lists', policy.allowedPeerLists.map(listName).join(', '))
  if (policy.allowedPeerGroups?.length) add('Also required (each)', policy.allowedPeerGroups.map((group) => [...(group.peerIds ?? []), ...(group.peerLists ?? []).map(listName)].join(' | ')).join('; '))
  if (policy.blockedPeerIds) add('Blocked sellers', policy.blockedPeerIds.join(', '))
  if (policy.blockedPeerLists) add('Blocked peer lists', policy.blockedPeerLists.map(listName).join(', '))
  if (policy.allowedModels) add('Allowed models', policy.allowedModels.join(', '))
  if (policy.minTrustScore !== undefined) add('Min trust', policy.minTrustScore)
  if (policy.minReputation !== undefined) add('Min reputation', policy.minReputation)
  if (policy.requireTee) add('Require TEE', 'yes')
  if (policy.requireVerified) add('Require verified', 'yes')
  if (policy.maxInputUsdPerMillion !== undefined) add('Max input $/M', policy.maxInputUsdPerMillion)
  if (policy.maxOutputUsdPerMillion !== undefined) add('Max output $/M', policy.maxOutputUsdPerMillion)
  if (policy.maxCachedInputUsdPerMillion !== undefined) add('Max cached input $/M', policy.maxCachedInputUsdPerMillion)
  if (policy.maxImageUsdPerImage !== undefined) add('Max $/image', policy.maxImageUsdPerImage)
  if (policy.preferFreePeers) add('Prefer free sellers', 'yes')
  if (policy.sort) add('Sort', policy.sort)
  if (policy.modelRoutes) add('Model routes', Object.entries(policy.modelRoutes).map(([model, route]) => `${model} → ${route.peerIds.join(' > ')}${route.strict ? ' (strict)' : ''}`).join('; '))
  return lines.length ? lines : [chalk.dim('(no restrictions)')]
}

export function confirmFlags(options: Record<string, unknown>): { confirmEmpty: boolean; acceptNarrowed: boolean } {
  return { confirmEmpty: options['confirmEmpty'] === true, acceptNarrowed: options['acceptNarrowed'] === true }
}
