import { MAX_SYSTEM_PROMPT, createPreset, deletePreset, requirePresetRecord, updatePreset } from '../../services/presets.js'
import type { PresetRecord } from '../../store.js'
import { activeMember, canSeeWorkspace, requestActor, requireOrgAdmin, requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { respond, type ConsoleRouter, type Principal } from '../router.js'
import { asObject, optionalString, policyFromWire, requiredString } from '../serialize.js'
import type { Preset } from '../types.js'

function presetDto(preset: PresetRecord): Preset {
  return {
    id: preset.id,
    slug: preset.slug,
    name: preset.name,
    workspaceId: preset.workspaceId,
    model: preset.model,
    routingPolicy: preset.routingPolicy,
    systemPrompt: preset.systemPrompt,
    params: preset.params,
    createdAt: preset.createdAt,
  }
}

/** Org-wide presets are edited by org admins; a workspace's by its admins. */
function requirePresetAdmin(deps: ConsoleDeps, p: Principal | null, workspaceId: string | null): void {
  if (workspaceId === null) requireOrgAdmin(p, deps.store)
  else requireWorkspaceAccess(deps.store, p, workspaceId, 'admin')
}

/**
 * Presets, called as `model: "@preset/<slug>"` (business rules in
 * `services/presets.ts`): a model with default params, a system prompt and a
 * routing policy that narrows the key's.
 */
export function registerPresetRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/presets', async ({ principal, query }) => {
    activeMember(store, principal)
    const workspace = query.get('workspace')
    return store.listPresets()
      .filter((preset) => preset.workspaceId === null || canSeeWorkspace(store, principal, preset.workspaceId))
      .filter((preset) => !workspace || preset.workspaceId === null || preset.workspaceId === workspace)
      .map(presetDto)
  })

  router.add('POST', '/presets', async (request) => {
    const input = asObject(request.body)
    const workspaceId = optionalString(input, 'workspaceId') ?? null
    requirePresetAdmin(deps, request.principal, workspaceId)
    const preset = createPreset(deps, requestActor(deps, request), {
      slug: requiredString(input, 'slug', 64),
      name: requiredString(input, 'name', 100),
      workspaceId,
      model: requiredString(input, 'model', 200),
      routingPolicy: policyFromWire(input['routingPolicy']) ?? null,
      systemPrompt: optionalString(input, 'systemPrompt', MAX_SYSTEM_PROMPT) ?? null,
      params: input['params'],
      confirmEmpty: input['confirmEmpty'] === true,
    })
    return respond(201, presetDto(preset))
  })

  router.add('PATCH', '/presets/:id', async (request) => {
    const preset = requirePresetRecord(deps, request.params['id']!)
    requirePresetAdmin(deps, request.principal, preset.workspaceId)
    const input = asObject(request.body)
    const updated = updatePreset(deps, requestActor(deps, request), preset.id, {
      ...(input['workspaceId'] !== undefined ? { workspaceId: input['workspaceId'] } : {}),
      ...(input['slug'] !== undefined ? { slug: requiredString(input, 'slug', 64) } : {}),
      ...(input['name'] !== undefined ? { name: requiredString(input, 'name', 100) } : {}),
      ...(input['model'] !== undefined ? { model: requiredString(input, 'model', 200) } : {}),
      ...(input['routingPolicy'] !== undefined ? { routingPolicy: policyFromWire(input['routingPolicy']) ?? null } : {}),
      ...(input['systemPrompt'] !== undefined ? { systemPrompt: optionalString(input, 'systemPrompt', MAX_SYSTEM_PROMPT) ?? null } : {}),
      ...(input['params'] !== undefined ? { params: input['params'] } : {}),
      confirmEmpty: input['confirmEmpty'] === true,
    })
    return presetDto(updated)
  })

  router.add('DELETE', '/presets/:id', async (request) => {
    const preset = requirePresetRecord(deps, request.params['id']!)
    requirePresetAdmin(deps, request.principal, preset.workspaceId)
    deletePreset(deps, requestActor(deps, request), preset.id)
    return respond(204)
  })
}
