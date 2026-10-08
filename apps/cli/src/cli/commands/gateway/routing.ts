import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { resolvePolicy } from '../../../gateway/policy-resolver.js'
import { previewRoute, type PreviewTarget } from '../../../gateway/services/network.js'
import { gatewayDefaultPolicy, setGatewayDefaultPolicy } from '../../../gateway/services/routing.js'
import type { GatewayStore } from '../../../gateway/store.js'
import { printResolved } from './key.js'
import { addConfirmOptions, addPolicyOptions, describePolicy, policyFromOptions } from './policy-options.js'
import { addBuyerPortOption, printJson, requireKey, requireMember, requireWorkspace, withGateway } from './shared.js'

interface TargetOptions { key?: string; workspace?: string; member?: string; preset?: string }

function addTargetOptions(cmd: Command): Command {
  return cmd
    .option('--key <id>', 'as a request with this API key (implies its workspace and owner)')
    .option('--workspace <id|name>', 'with this workspace\'s policies')
    .option('--member <member>', 'with this member\'s policy (id or email)')
    .option('--preset <slug>', 'calling this preset (`@preset/<slug>`)')
}

function previewTarget(store: GatewayStore, options: TargetOptions): PreviewTarget {
  const key = options.key ? requireKey(store, options.key) : null
  const workspaceId = options.workspace ? requireWorkspace(store, options.workspace).id : undefined
  if (key && workspaceId && workspaceId !== key.workspaceId) throw new Error('That key belongs to another workspace.')
  return {
    ...(key ? { keyId: key.id } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(options.member ? { memberId: requireMember(store, options.member).id } : {}),
    ...(options.preset ? { presetSlug: options.preset } : {}),
  }
}

export function registerGatewayRoutingCommands(gateway: Command): void {
  const routing = gateway.command('routing').description('The gateway-wide default routing policy, and route previews')

  addTargetOptions(
    routing.command('show')
      .description('Show the gateway default policy, or with --key/--workspace/--member/--preset the effective policy there'),
  )
    .option('--json', 'print machine-readable JSON', false)
    .action((options: TargetOptions & { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const target = previewTarget(store, options)
      if (Object.keys(target).length === 0) {
        const policy = gatewayDefaultPolicy(store)
        if (options.json) {
          printJson(policy ?? {})
          return
        }
        console.log(chalk.bold('Gateway default routing policy:'))
        for (const line of describePolicy(policy, store)) console.log(`  ${line}`)
        return
      }
      const resolved = resolvePolicy(store, target)
      if (options.json) {
        printJson({ effective: resolved.policy, sources: resolved.sources })
        return
      }
      printResolved(store, resolved)
    }))

  addConfirmOptions(addPolicyOptions(
    routing.command('set').description('Set the gateway default routing policy, the top level every key inherits (replaces it unless --merge)'),
  ), false).action((options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
    const policy = setGatewayDefaultPolicy(ctx, actor, policyFromOptions(store, options, gatewayDefaultPolicy(store)), { confirmEmpty: options['confirmEmpty'] === true })
    console.log(chalk.bold('Gateway default routing policy:'))
    for (const line of describePolicy(policy, store)) console.log(`  ${line}`)
  }))

  routing.command('clear')
    .description('Remove the gateway default routing policy')
    .action((_options: unknown, cmd: Command) => withGateway(cmd, ({ ctx, actor }) => {
      setGatewayDefaultPolicy(ctx, actor, {})
      console.log('Cleared the gateway default routing policy.')
    }))

  addBuyerPortOption(addTargetOptions(
    routing.command('preview')
      .description('Which sellers a request would route to, ranked by the running buyer, with the reasons others are excluded')
      .requiredOption('--model <id>', 'model id (or peer@model)'),
  ))
    .option('--all', 'also list ineligible sellers', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: TargetOptions & { model: string; all: boolean; json: boolean }, cmd: Command) => withGateway(cmd, async ({ store, buyer }) => {
      const preview = await previewRoute(store, await buyer(), options.model.trim(), previewTarget(store, options))
      if (options.json) {
        printJson(preview)
        return
      }
      console.log(`${chalk.bold('Model:')} ${preview.model}`)
      if (!preview.modelAllowed) {
        console.log(chalk.red('This model is not allowed by the effective policy (allowedModels); the gateway answers 403 model_not_allowed.'))
        return
      }
      const levels = preview.sources.filter((source) => source.policy && Object.keys(source.policy).length > 0).map((source) => source.level)
      console.log(`${chalk.bold('Policy from:')} ${levels.length ? levels.join(' → ') : 'no gateway-side restrictions'} ${chalk.dim('(plus the buyer\'s own config)')}`)
      const shown = preview.candidates.filter((candidate) => options.all || candidate.eligible)
      if (shown.length === 0) {
        console.log(chalk.yellow(preview.candidates.length ? 'No eligible seller; rerun with --all to see why.' : 'No seller offers this model right now.'))
        return
      }
      const table = new Table({ head: ['Rank', 'Seller', 'Name', 'In $/M', 'Out $/M', 'Trust', 'Reasons'] })
      for (const candidate of shown) {
        table.push([
          candidate.rank === null ? (candidate.eligible ? '-' : chalk.red('x')) : String(candidate.rank),
          candidate.peerId,
          candidate.displayName ?? '-',
          candidate.inputUsdPerMillion ?? '-',
          candidate.outputUsdPerMillion ?? '-',
          candidate.trustScore ?? '-',
          candidate.reasons.join('; ') || '-',
        ])
      }
      console.log(table.toString())
      const ineligible = preview.candidates.length - preview.candidates.filter((candidate) => candidate.eligible).length
      if (!options.all && ineligible > 0) console.log(chalk.dim(`${ineligible} ineligible seller(s) hidden; --all shows them with reasons.`))
    }))
}
