import type { RoutingPolicy } from '../../routing-policy/policy.js'
import { ConsoleError } from '../console-api/router.js'
import { badRequest, notFound } from '../console-api/serialize.js'
import { checkPolicyInput, policyInputProblem } from '../policy-resolver.js'
import { PRESET_MODEL_PREFIX } from '../request-shaping.js'
import type { PresetRecord } from '../store.js'
import { changedFields, recordAudit, requiredText, throwIfProblem, type Actor, type ServiceContext } from './context.js'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_NAME = 100
const MAX_MODEL = 200
export const MAX_SYSTEM_PROMPT = 32 * 1024
const MAX_PARAMS_BYTES = 16 * 1024

function target(preset: PresetRecord) {
  return { kind: 'preset', id: preset.id, label: preset.slug }
}

function cleanSlug(value: string): string {
  const slug = requiredText(value, 'slug', 64)
  if (!SLUG_PATTERN.test(slug)) throw badRequest('slug uses lowercase letters, digits and dashes')
  return slug
}

function cleanModel(value: string): string {
  const model = requiredText(value, 'model', MAX_MODEL)
  if (model.startsWith(PRESET_MODEL_PREFIX)) throw badRequest('A preset cannot point at another preset')
  return model
}

function cleanSystemPrompt(value: string | null): string | null {
  if (value === null) return null
  if (value.length > MAX_SYSTEM_PROMPT) throw badRequest(`systemPrompt is longer than ${MAX_SYSTEM_PROMPT} characters`)
  return value.trim() || null
}

/** Default request params; `model` is the preset's own field, so it is dropped here. */
function cleanParams(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('params must be an object')
  if (JSON.stringify(value).length > MAX_PARAMS_BYTES) throw badRequest('params are too large')
  const params = { ...(value as Record<string, unknown>) }
  delete params['model']
  return params
}

/** A preset whose policy would leave no seller needs `confirmEmpty`; narrowing by the levels above is expected. */
function checkPresetPolicy(ctx: ServiceContext, workspaceId: string | null, policy: RoutingPolicy | null, confirmEmpty: boolean | undefined): void {
  throwIfProblem(policyInputProblem(
    [{ field: 'routingPolicy', check: checkPolicyInput(ctx.store, workspaceId ? { workspaceId } : {}, 'preset', policy) }],
    { confirmEmpty: confirmEmpty === true, acceptNarrowed: true },
  ))
}

function assertSlugFree(ctx: ServiceContext, slug: string, workspaceId: string | null, exceptId?: string): void {
  const clash = ctx.store.listPresets().some((preset) => preset.id !== exceptId && preset.slug === slug && preset.workspaceId === workspaceId)
  if (clash) throw new ConsoleError(409, 'preset_exists', `A preset named "${slug}" already exists here`)
}

export function requirePresetRecord(ctx: Pick<ServiceContext, 'store'>, id: string): PresetRecord {
  const preset = ctx.store.getPreset(id)
  if (!preset) throw notFound('Preset')
  return preset
}

export interface CreatePresetInput {
  slug: string
  name: string
  /** Null: org-wide. */
  workspaceId: string | null
  model: string
  routingPolicy?: RoutingPolicy | null
  systemPrompt?: string | null
  params?: unknown
  confirmEmpty?: boolean
}

/** Presets are called as `model: "@preset/<slug>"`: a model with default params, a system prompt and a policy that narrows the key's. */
export function createPreset(ctx: ServiceContext, actor: Actor, input: CreatePresetInput): PresetRecord {
  if (input.workspaceId !== null && !ctx.store.getWorkspace(input.workspaceId)) throw notFound('Workspace')
  const slug = cleanSlug(input.slug)
  assertSlugFree(ctx, slug, input.workspaceId)
  const systemPrompt = cleanSystemPrompt(input.systemPrompt ?? null)
  const routingPolicy = input.routingPolicy ?? null
  checkPresetPolicy(ctx, input.workspaceId, routingPolicy, input.confirmEmpty)
  const preset = ctx.store.createPreset({
    slug,
    name: requiredText(input.name, 'name', MAX_NAME),
    workspaceId: input.workspaceId,
    model: cleanModel(input.model),
    routingPolicy,
    systemPrompt,
    params: cleanParams(input.params),
  })
  recordAudit(ctx, actor, 'preset.create', target(preset), { workspaceId: input.workspaceId, model: preset.model, routingPolicy: preset.routingPolicy })
  return preset
}

export interface UpdatePresetInput {
  slug?: string
  name?: string
  /** Refused unless unchanged: presets never move between workspaces. */
  workspaceId?: unknown
  model?: string
  routingPolicy?: RoutingPolicy | null
  systemPrompt?: string | null
  params?: unknown
  confirmEmpty?: boolean
}

export function updatePreset(ctx: ServiceContext, actor: Actor, id: string, input: UpdatePresetInput): PresetRecord {
  const preset = requirePresetRecord(ctx, id)
  if (input.workspaceId !== undefined && input.workspaceId !== preset.workspaceId) throw badRequest('A preset cannot move between workspaces')
  let slug: string | undefined
  if (input.slug !== undefined) {
    slug = cleanSlug(input.slug)
    assertSlugFree(ctx, slug, preset.workspaceId, preset.id)
  }
  const systemPrompt = input.systemPrompt === undefined ? undefined : cleanSystemPrompt(input.systemPrompt)
  if (input.routingPolicy !== undefined) checkPresetPolicy(ctx, preset.workspaceId, input.routingPolicy, input.confirmEmpty)
  const updated = ctx.store.updatePreset(preset.id, {
    ...(slug ? { slug } : {}),
    ...(input.name !== undefined ? { name: requiredText(input.name, 'name', MAX_NAME) } : {}),
    ...(input.model !== undefined ? { model: cleanModel(input.model) } : {}),
    ...(input.routingPolicy !== undefined ? { routingPolicy: input.routingPolicy } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(input.params !== undefined ? { params: cleanParams(input.params) } : {}),
  })
  // Changed fields only; the system prompt is content, so just whether it changed.
  const changes: Record<string, unknown> = changedFields(preset, updated, ['slug', 'name', 'model', 'routingPolicy', 'params'])
  if (preset.systemPrompt !== updated.systemPrompt) changes['systemPromptChanged'] = true
  recordAudit(ctx, actor, 'preset.update', target(updated), changes)
  return updated
}

export function deletePreset(ctx: ServiceContext, actor: Actor, id: string): PresetRecord {
  const preset = requirePresetRecord(ctx, id)
  ctx.store.deletePreset(preset.id)
  recordAudit(ctx, actor, 'preset.delete', target(preset), { workspaceId: preset.workspaceId })
  return preset
}

/** A preset by id, or by slug (org-wide first, unless `workspaceId` narrows it to that workspace's). */
export function findPreset(ctx: Pick<ServiceContext, 'store'>, idOrSlug: string, workspaceId?: string | null): PresetRecord {
  const byId = ctx.store.getPreset(idOrSlug)
  if (byId) return byId
  const matches = ctx.store.listPresets().filter((preset) => preset.slug === idOrSlug && (workspaceId === undefined || preset.workspaceId === workspaceId))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw badRequest(`Several presets are named "${idOrSlug}"; use the preset id or pass the workspace`)
  throw notFound('Preset')
}
