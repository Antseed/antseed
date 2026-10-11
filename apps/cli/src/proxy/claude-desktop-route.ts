import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types'
import { ROUTED_MODEL_ALIAS } from './request-utils.js'

/**
 * Claude Desktop's third-party gateway route on the buyer proxy.
 *
 * Claude Desktop, once its profile's gateway base URL is
 * `http://127.0.0.1:<buyerPort>/claude-desktop`, sends `GET /v1/models` for
 * its picker and `POST /v1/messages` (+ `/count_tokens`) for inference under
 * that prefix. Its picker only accepts Anthropic's model-list shape and only
 * lists model ids it knows, so network models are advertised behind Claude's
 * own ids (as Ollama's gateway does) and each message's model is rewritten
 * back to the model its id was advertised for. The prefix keeps that rewrite
 * away from other Anthropic clients that send real Claude model names.
 */
export const CLAUDE_DESKTOP_ROUTE_PREFIX = '/claude-desktop'
export const CLAUDE_DESKTOP_SOURCE = 'claude-desktop'

/**
 * Claude's own ids, in its preferred order. The first slot is always
 * "Antseed Auto" (the buyer's default route); the rest carry picked models.
 */
const CLAUDE_MODEL_SLOTS: readonly { id: string; family: string; createdAt: string; familyDefault: boolean }[] = [
  { id: 'claude-fable-5', family: 'fable', createdAt: '2026-06-09T00:00:00Z', familyDefault: true },
  { id: 'claude-opus-5', family: 'opus', createdAt: '2026-07-24T00:00:00Z', familyDefault: true },
  { id: 'claude-sonnet-5', family: 'sonnet', createdAt: '2026-06-30T00:00:00Z', familyDefault: true },
  { id: 'claude-sonnet-4-6', family: 'sonnet', createdAt: '2025-11-18T00:00:00Z', familyDefault: false },
  { id: 'claude-haiku-4-5-20251001', family: 'haiku', createdAt: '2025-10-01T00:00:00Z', familyDefault: true },
]
const AUTO_SLOT = CLAUDE_MODEL_SLOTS[0]!
const ASSIGNABLE_SLOTS = CLAUDE_MODEL_SLOTS.slice(1)
const AUTO_LABEL = 'Antseed Auto'

/** A model offered to Claude's picker: display label + the model the buyer routes. */
export type ClaudeDesktopModel = { label: string; model: string }

/** Returns the path under the Claude Desktop prefix, or null for any other path. */
export function claudeDesktopSubpath(path: string): string | null {
  const pathname = path.split('?')[0] ?? ''
  if (pathname === CLAUDE_DESKTOP_ROUTE_PREFIX) return '/'
  return pathname.startsWith(`${CLAUDE_DESKTOP_ROUTE_PREFIX}/`) ? pathname.slice(CLAUDE_DESKTOP_ROUTE_PREFIX.length) : null
}

export class ClaudeDesktopRoute {
  /** Models pushed by the desktop app (its curated picker); null = use the buyer ranking. */
  private pushedModels: ClaudeDesktopModel[] | null = null
  /** Claude slot id → model to route, as last advertised by /v1/models. */
  private slotModels = new Map<string, string>()
  /** Claude slot id → display name last advertised for its model. */
  private slotLabels = new Map<string, string>()

  /**
   * `stateFile` keeps slot bindings and the pushed picker across restarts:
   * Claude caches the catalog it fetched, so an id it already shows must keep
   * meaning the same model after the buyer restarts.
   */
  constructor(private readonly stateFile: string) {
    this.load()
  }

  /** Curated picker models from the desktop app; an empty list falls back to the buyer ranking. */
  setPushedModels(models: readonly ClaudeDesktopModel[]): void {
    this.pushedModels = models.length > 0 ? models.map((entry) => ({ label: entry.label, model: entry.model })) : null
    this.persist()
  }

  /** Anthropic-shaped `/v1/models` body; `rankedModels` fill the slots when nothing was pushed. */
  modelsResponse(rankedModels: readonly ClaudeDesktopModel[]): Record<string, unknown> {
    const data = this.assignSlots(this.pushedModels ?? rankedModels).map(({ slot, label }) => ({
      id: slot.id,
      type: 'model',
      display_name: label,
      created_at: slot.createdAt,
      max_tokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      anthropic_family_tier: slot.family,
      is_family_default: slot.familyDefault,
    }))
    return { data, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null, has_more: false }
  }

  /**
   * Rewrites the requested model to what its Claude id was advertised for,
   * falling back to the routed-model alias. With `routingNote`, a short note
   * is appended to the system prompt saying the conversation runs through
   * Antseed. Non-JSON bodies pass through so the normal path reports the error.
   */
  rewriteRequest(body: Buffer, opts: { routingNote: boolean }): Buffer {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return body
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
    const request = parsed as Record<string, unknown>
    const model = request['model']
    const passthrough = typeof model === 'string' && (model === ROUTED_MODEL_ALIAS || model.includes('@'))
    if (passthrough && !opts.routingNote) return body
    if (!passthrough) {
      request['model'] = (typeof model === 'string' ? this.slotModels.get(model) : undefined) ?? ROUTED_MODEL_ALIAS
    }
    if (opts.routingNote) appendRoutingNote(request)
    return Buffer.from(JSON.stringify(request), 'utf8')
  }

  /**
   * "Antseed Auto" always holds the first slot; offered models take the rest.
   * Bindings are sticky per model, not positional, so a reorder never
   * re-points an id Claude already shows. A model keeps its slot while it is
   * still offered; slots whose model left are free for new ones.
   */
  private assignSlots(offered: readonly ClaudeDesktopModel[]): { slot: typeof AUTO_SLOT; label: string; model: string }[] {
    const seen = new Set<string>()
    const labels = new Map<string, string>()
    const picks: string[] = []
    for (const entry of offered) {
      const model = entry.model.trim()
      if (!model || model === ROUTED_MODEL_ALIAS || seen.has(model)) continue
      seen.add(model)
      labels.set(model, entry.label.trim() || model)
      picks.push(model)
    }

    // Nothing offered yet (fresh start, no peers): keep the persisted
    // bindings rather than letting Claude's cached ids fall back to Auto.
    if (picks.length > 0) {
      const bindings = new Map<string, string>()
      for (const slot of ASSIGNABLE_SLOTS) {
        const model = this.slotModels.get(slot.id)
        if (model && seen.has(model)) bindings.set(slot.id, model)
      }
      const bound = new Set(bindings.values())
      // A network model named like a Claude id claims that slot first.
      for (const model of picks) {
        const ownSlot = ASSIGNABLE_SLOTS.find((slot) => slot.id === model && !bindings.has(slot.id))
        if (bound.has(model) || !ownSlot) continue
        bindings.set(ownSlot.id, model)
        bound.add(model)
      }
      for (const model of picks) {
        if (bound.has(model)) continue
        const free = ASSIGNABLE_SLOTS.find((slot) => !bindings.has(slot.id))
        if (!free) break
        bindings.set(free.id, model)
        bound.add(model)
      }
      this.slotLabels = new Map([...bindings].map(([slotId, model]) => [slotId, labels.get(model) ?? model]))
      this.slotModels = bindings
      this.persist()
    }

    const assignments = [{ slot: AUTO_SLOT, label: AUTO_LABEL, model: ROUTED_MODEL_ALIAS }]
    for (const slot of ASSIGNABLE_SLOTS) {
      const model = this.slotModels.get(slot.id)
      if (model) assignments.push({ slot, label: this.slotLabels.get(slot.id) ?? model, model })
    }
    return assignments
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Record<string, unknown>
      const slots = asRecord(raw['slots'])
      for (const slot of ASSIGNABLE_SLOTS) {
        const entry = asRecord(slots[slot.id])
        if (typeof entry['model'] !== 'string' || entry['model'].trim().length === 0) continue
        this.slotModels.set(slot.id, entry['model'])
        this.slotLabels.set(slot.id, typeof entry['label'] === 'string' && entry['label'].trim() ? entry['label'] : entry['model'])
      }
      if (Array.isArray(raw['pushedModels'])) this.pushedModels = parseModels(raw['pushedModels'])
    } catch {
      // Missing or unreadable state: bindings start fresh.
    }
  }

  private persist(): void {
    const slots: Record<string, ClaudeDesktopModel> = {}
    for (const [slotId, model] of this.slotModels) slots[slotId] = { model, label: this.slotLabels.get(slotId) ?? model }
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, `${JSON.stringify({ slots, pushedModels: this.pushedModels }, null, 2)}\n`, 'utf8')
    } catch {
      // Best effort: bindings still hold for this process.
    }
  }
}

/** Validates a pushed picker list (`[{ label, model }]`); null when malformed. */
export function parseModels(value: unknown): ClaudeDesktopModel[] | null {
  if (!Array.isArray(value)) return null
  const models: ClaudeDesktopModel[] = []
  for (const item of value) {
    const entry = asRecord(item)
    if (typeof entry['model'] !== 'string' || entry['model'].trim().length === 0) return null
    models.push({ model: entry['model'].trim(), label: typeof entry['label'] === 'string' ? entry['label'] : entry['model'] })
  }
  return models
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const ROUTING_NOTE = 'Note from Antseed: this conversation is delivered through the Antseed peer-to-peer '
  + 'network, not directly through Anthropic. Environment metadata comes from the Claude client '
  + 'infrastructure and may not describe the model actually serving the conversation.'

/** Appended as the last system block so earlier prompt-cache breakpoints stay valid. */
function appendRoutingNote(request: Record<string, unknown>): void {
  const system = request['system']
  if (system === undefined || system === null) {
    request['system'] = ROUTING_NOTE
  } else if (typeof system === 'string') {
    request['system'] = `${system}\n\n${ROUTING_NOTE}`
  } else if (Array.isArray(system)) {
    request['system'] = [...system, { type: 'text', text: ROUTING_NOTE }]
  }
}
