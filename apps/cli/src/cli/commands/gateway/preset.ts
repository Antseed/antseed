import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { errorMessage } from '../../../gateway/errors.js'
import { createPreset, deletePreset, findPreset, updatePreset } from '../../../gateway/services/presets.js'
import type { GatewayStore, PresetRecord } from '../../../gateway/store.js'
import { addPolicyOptions, collect, describePolicy, hasPolicyOptions, policyFromOptions } from './policy-options.js'
import { isoOrNull, printJson, requireWorkspace, withGateway } from './shared.js'

function presetJson(preset: PresetRecord) {
  return { ...preset, createdAt: isoOrNull(preset.createdAt) }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Could not read ${path}: ${errorMessage(error)}`)
  }
}

/** `--params-file` (JSON object) and `--param key=value` (value parsed as JSON when it can be). */
function paramsFrom(options: Record<string, unknown>, base: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  if (options['paramsFile'] === undefined && options['param'] === undefined) return undefined
  let params: Record<string, unknown> = { ...base }
  if (typeof options['paramsFile'] === 'string') {
    const parsed = JSON.parse(readText(options['paramsFile'])) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--params-file must hold a JSON object.')
    params = { ...params, ...(parsed as Record<string, unknown>) }
  }
  for (const pair of (options['param'] as string[] | undefined) ?? []) {
    const at = pair.indexOf('=')
    if (at <= 0) throw new Error(`--param "${pair}" must look like key=value.`)
    const raw = pair.slice(at + 1)
    let value: unknown = raw
    try { value = JSON.parse(raw) } catch { /* a plain string */ }
    params[pair.slice(0, at)] = value
  }
  return params
}

function systemPromptFrom(options: Record<string, unknown>): string | null | undefined {
  if (typeof options['systemPromptFile'] === 'string') return readText(options['systemPromptFile'])
  if (typeof options['systemPrompt'] === 'string') return options['systemPrompt'] || null
  return undefined
}

function addPresetContentOptions(cmd: Command): Command {
  return cmd
    .option('--system-prompt <text>', 'system prompt added to every request ("" removes it)')
    .option('--system-prompt-file <path>', 'read the system prompt from a file')
    .option('--param <key=value>', 'default request parameter, e.g. temperature=0.2 (repeatable)', collect)
    .option('--params-file <path>', 'default request parameters as a JSON object')
}

/** `--workspace`: unset matches any preset, "org" the org-wide ones, else that workspace's. */
function resolvePreset(store: GatewayStore, ref: string, workspace?: string): PresetRecord {
  if (workspace === undefined) return findPreset({ store }, ref)
  return findPreset({ store }, ref, workspace === 'org' ? null : requireWorkspace(store, workspace).id)
}

export function registerGatewayPresetCommands(gateway: Command): void {
  const preset = gateway.command('preset').description('Presets, called as model "@preset/<slug>": a model with default params, a system prompt and a routing policy')

  preset.command('list')
    .description('List presets')
    .option('--workspace <id|name>', 'only org-wide presets and this workspace\'s')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { workspace?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const workspaceId = options.workspace ? requireWorkspace(store, options.workspace).id : null
      const presets = store.listPresets().filter((record) => !workspaceId || record.workspaceId === null || record.workspaceId === workspaceId)
      if (options.json) {
        printJson(presets.map(presetJson))
        return
      }
      if (presets.length === 0) {
        console.log(chalk.dim('No presets. Create one with `antseed gateway preset create --slug <slug> --name <name> --model <model>`.'))
        return
      }
      const names = new Map(store.listWorkspaces().map((workspace) => [workspace.id, workspace.name]))
      const table = new Table({ head: ['Id', 'Call as', 'Name', 'Workspace', 'Model', 'Policy'] })
      for (const record of presets) {
        table.push([
          record.id,
          `@preset/${record.slug}`,
          record.name,
          record.workspaceId === null ? 'org-wide' : names.get(record.workspaceId) ?? record.workspaceId,
          record.model,
          record.routingPolicy ? 'yes' : '-',
        ])
      }
      console.log(table.toString())
    }))

  preset.command('show')
    .description('Show a preset')
    .argument('<preset>', 'preset id or slug')
    .option('--workspace <id|name|org>', 'which preset of that slug: a workspace\'s, or "org" for the org-wide one')
    .option('--json', 'print machine-readable JSON', false)
    .action((ref: string, options: { workspace?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const record = resolvePreset(store, ref, options.workspace)
      if (options.json) {
        printJson(presetJson(record))
        return
      }
      console.log(`${chalk.bold(record.name)} ${chalk.dim(record.id)}  @preset/${record.slug}`)
      console.log(`Workspace: ${record.workspaceId === null ? 'org-wide' : store.getWorkspace(record.workspaceId)?.name ?? record.workspaceId}`)
      console.log(`Model: ${record.model}`)
      console.log(`Params: ${Object.keys(record.params).length ? JSON.stringify(record.params) : '-'}`)
      console.log(`System prompt: ${record.systemPrompt ? `${record.systemPrompt.length} characters` : '-'}`)
      console.log(chalk.bold('Routing policy:'))
      for (const line of describePolicy(record.routingPolicy, store)) console.log(`  ${line}`)
    }))

  addPolicyOptions(addPresetContentOptions(
    preset.command('create')
      .description('Create a preset (org-wide, or in a workspace with --workspace)')
      .requiredOption('--slug <slug>', 'called as @preset/<slug>; lowercase letters, digits and dashes')
      .requiredOption('--name <name>', 'display name')
      .requiredOption('--model <model>', 'model the preset calls')
      .option('--workspace <id|name>', 'only for this workspace\'s keys'),
  ))
    .option('--confirm-empty', 'save even if the policy would leave no seller able to serve', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = createPreset(ctx, actor, {
        slug: String(options['slug']),
        name: String(options['name']),
        model: String(options['model']),
        workspaceId: typeof options['workspace'] === 'string' ? requireWorkspace(store, options['workspace']).id : null,
        routingPolicy: hasPolicyOptions(options) ? policyFromOptions(store, options) : null,
        systemPrompt: systemPromptFrom(options) ?? null,
        params: paramsFrom(options) ?? {},
        confirmEmpty: options['confirmEmpty'] === true,
      })
      if (options['json']) {
        printJson(presetJson(record))
        return
      }
      console.log(chalk.green(`Created preset ${record.id}; call it as model "@preset/${record.slug}".`))
    }))

  addPolicyOptions(addPresetContentOptions(
    preset.command('update')
      .description('Change a preset; policy flags replace its policy (or --merge), --clear-policy removes it')
      .argument('<preset>', 'preset id or slug')
      .option('--in-workspace <id|name|org>', 'which preset of that slug: a workspace\'s, or "org" for the org-wide one')
      .option('--slug <slug>', 'new slug')
      .option('--name <name>', 'new name')
      .option('--model <model>', 'new model')
      .option('--clear-policy', 'remove the preset\'s routing policy', false),
  ))
    .option('--confirm-empty', 'save even if the policy would leave no seller able to serve', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((ref: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = resolvePreset(store, ref, options['inWorkspace'] as string | undefined)
      if (options['clearPolicy'] && hasPolicyOptions(options)) throw new Error('Use either --clear-policy or policy flags.')
      const params = paramsFrom(options, options['merge'] ? record.params : {})
      const systemPrompt = systemPromptFrom(options)
      const updated = updatePreset(ctx, actor, record.id, {
        ...(typeof options['slug'] === 'string' ? { slug: options['slug'] } : {}),
        ...(typeof options['name'] === 'string' ? { name: options['name'] } : {}),
        ...(typeof options['model'] === 'string' ? { model: options['model'] } : {}),
        ...(hasPolicyOptions(options) ? { routingPolicy: policyFromOptions(store, options, record.routingPolicy) } : {}),
        ...(options['clearPolicy'] ? { routingPolicy: null } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(params !== undefined ? { params } : {}),
        confirmEmpty: options['confirmEmpty'] === true,
      })
      if (options['json']) {
        printJson(presetJson(updated))
        return
      }
      console.log(`Updated preset @preset/${updated.slug} (${updated.id}).`)
    }))

  preset.command('delete')
    .description('Delete a preset')
    .argument('<preset>', 'preset id or slug')
    .option('--workspace <id|name|org>', 'which preset of that slug: a workspace\'s, or "org" for the org-wide one')
    .action((ref: string, options: { workspace?: string }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = deletePreset(ctx, actor, resolvePreset(store, ref, options.workspace).id)
      console.log(`Deleted preset @preset/${record.slug} (${record.id}).`)
    }))
}
