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
 * "Antseed Auto" (the buyer's default route) sits on `claude-fable-5`: Claude
 * Desktop's catalog makes that id the default model for gateways, so Claude
 * marks Auto as "Default" and starts new chats on it.
 */
const AUTO_SLOT = { id: 'claude-fable-5', family: 'fable', createdAt: '2026-06-09T00:00:00Z', familyDefault: true }
/**
 * Claude's own ids, which carry the picked models. Claude Desktop turns off
 * its Auto permission mode for ids it treats as older models (Claude 3, 4.0 to
 * 4.5, Opus/Sonnet 4.6, and any Haiku), so every id here is a newer one.
 */
const ASSIGNABLE_SLOTS: readonly (typeof AUTO_SLOT)[] = [
  { id: 'claude-opus-5', family: 'opus', createdAt: '2026-07-24T00:00:00Z', familyDefault: true },
  { id: 'claude-sonnet-5', family: 'sonnet', createdAt: '2026-06-30T00:00:00Z', familyDefault: true },
  { id: 'claude-opus-5-5', family: 'opus', createdAt: '2026-09-15T00:00:00Z', familyDefault: false },
  { id: 'claude-sonnet-5-5', family: 'sonnet', createdAt: '2026-09-15T00:00:00Z', familyDefault: false },
  { id: 'claude-fable-5-1', family: 'fable', createdAt: '2026-09-15T00:00:00Z', familyDefault: false },
]
/**
 * Ids used before, which turned off Claude's Auto mode; their bindings move
 * to the new ids, and chats Claude saved on them keep reaching the same model.
 */
const LEGACY_SLOT_IDS: Readonly<Record<string, string>> = {
  'claude-sonnet-4-6': 'claude-opus-5-5',
  'claude-haiku-4-5-20251001': 'claude-sonnet-5-5',
}
/**
 * A slot file can still bind a model to `claude-fable-5`, which is Auto's id
 * now: that binding moves to `claude-fable-5-1`. Requests on `claude-fable-5`
 * go to Auto, so this applies only when loading.
 */
const LOADED_SLOT_IDS: Readonly<Record<string, string>> = { ...LEGACY_SLOT_IDS, 'claude-fable-5': 'claude-fable-5-1' }
const AUTO_LABEL = 'Antseed Auto'
/**
 * Claude shows a model's `description` under its name, and otherwise the
 * tagline of the Claude family its id belongs to ("For your toughest
 * challenges"), which says nothing about the network model behind it.
 */
const AUTO_DESCRIPTION = 'Uses the model selected in the AI VPN'
/** Network models are named as such, so they are not mistaken for Anthropic's own. */
const modelLabel = (label: string): string => `${label} (Antseed)`
/**
 * Network models show a dash for a description. Claude replaces an empty,
 * whitespace-only or invisible one with the Claude family tagline.
 */
const BLANK_DESCRIPTION = '-'

/** A model offered to Claude's picker: display label + the model the buyer routes. */
export type ClaudeDesktopModel = { label: string; model: string }

/** Returns the path under the Claude Desktop prefix, or null for any other path. */
export function claudeDesktopSubpath(path: string): string | null {
  const pathname = path.split('?')[0] ?? ''
  if (pathname === CLAUDE_DESKTOP_ROUTE_PREFIX) return '/'
  return pathname.startsWith(`${CLAUDE_DESKTOP_ROUTE_PREFIX}/`) ? pathname.slice(CLAUDE_DESKTOP_ROUTE_PREFIX.length) : null
}

export class ClaudeDesktopRoute {
  /** Claude slot id → model to route, as last advertised by /v1/models. */
  private slotModels = new Map<string, string>()
  /** Claude slot id → display name last advertised for its model. */
  private slotLabels = new Map<string, string>()

  /**
   * `stateFile` keeps slot bindings across restarts:
   * Claude caches the catalog it fetched, so an id it already shows must keep
   * meaning the same model after the buyer restarts.
   */
  constructor(private readonly stateFile: string) {
    this.load()
  }

  /** Anthropic-shaped `/v1/models` body; `models` (the curated picker list) fill the slots in order. */
  modelsResponse(models: readonly ClaudeDesktopModel[]): Record<string, unknown> {
    const data = this.assignSlots(models).map(({ slot, label }) => ({
      id: slot.id,
      type: 'model',
      display_name: label,
      description: slot === AUTO_SLOT ? AUTO_DESCRIPTION : BLANK_DESCRIPTION,
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
    const slotId = typeof model === 'string' ? LEGACY_SLOT_IDS[model] ?? model : undefined
    const routed = !passthrough && slotId !== undefined ? this.slotModels.get(slotId) : undefined
    if (!passthrough) request['model'] = routed ?? ROUTED_MODEL_ALIAS
    if (opts.routingNote) appendRoutingNote(request, routed ? { label: this.slotLabels.get(slotId!) ?? routed, model: routed } : null)
    return Buffer.from(JSON.stringify(request), 'utf8')
  }

  /**
   * "Antseed Auto" comes first, then the first offered models in their
   * offered (curated) order, as many as there are Claude ids. Bindings are
   * sticky per model, not positional, so a reorder never re-points an id
   * Claude already shows: a listed model keeps its id, and only ids whose
   * model dropped off the list are reused.
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
      if (picks.length === ASSIGNABLE_SLOTS.length) break
    }

    // Nothing offered yet (fresh start, no peers): keep the persisted
    // bindings rather than letting Claude's cached ids fall back to Auto.
    let order: string[]
    if (picks.length > 0) {
      const listed = new Set(picks)
      const bindings = new Map<string, string>()
      for (const slot of ASSIGNABLE_SLOTS) {
        const model = this.slotModels.get(slot.id)
        if (model && listed.has(model)) bindings.set(slot.id, model)
      }
      const bound = new Set(bindings.values())
      for (const model of picks) {
        if (bound.has(model)) continue
        // A network model named like a free Claude id takes that id;
        // otherwise the first free id. This picks an id, never a position.
        const free = ASSIGNABLE_SLOTS.find((slot) => slot.id === model && !bindings.has(slot.id))
          ?? ASSIGNABLE_SLOTS.find((slot) => !bindings.has(slot.id))
        if (!free) break
        bindings.set(free.id, model)
        bound.add(model)
      }
      this.slotLabels = new Map([...bindings].map(([slotId, model]) => [slotId, labels.get(model) ?? model]))
      this.slotModels = bindings
      this.persist()
      order = picks
    } else {
      order = ASSIGNABLE_SLOTS.flatMap((slot) => this.slotModels.get(slot.id) ?? [])
    }

    const slotOf = new Map([...this.slotModels].map(([slotId, model]) => [model, ASSIGNABLE_SLOTS.find((slot) => slot.id === slotId)!]))
    const assignments = [{ slot: AUTO_SLOT, label: AUTO_LABEL, model: ROUTED_MODEL_ALIAS }]
    for (const model of order) {
      const slot = slotOf.get(model)
      if (slot) assignments.push({ slot, label: modelLabel(this.slotLabels.get(slot.id) ?? model), model })
    }
    return assignments
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Record<string, unknown>
      const slots = asRecord(raw['slots'])
      for (const slot of ASSIGNABLE_SLOTS) {
        const legacyId = Object.keys(LOADED_SLOT_IDS).find((id) => LOADED_SLOT_IDS[id] === slot.id)
        const entry = asRecord(slots[slot.id] ?? (legacyId ? slots[legacyId] : undefined))
        if (typeof entry['model'] !== 'string' || entry['model'].trim().length === 0) continue
        this.slotModels.set(slot.id, entry['model'])
        this.slotLabels.set(slot.id, typeof entry['label'] === 'string' && entry['label'].trim() ? entry['label'] : entry['model'])
      }
    } catch {
      // Missing or unreadable state: bindings start fresh.
    }
  }

  private persist(): void {
    const slots: Record<string, ClaudeDesktopModel> = {}
    for (const [slotId, model] of this.slotModels) slots[slotId] = { model, label: this.slotLabels.get(slotId) ?? model }
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, `${JSON.stringify({ slots }, null, 2)}\n`, 'utf8')
    } catch {
      // Best effort: bindings still hold for this process.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const ROUTING_NOTE = 'Note from Antseed: this conversation is delivered through the Antseed peer-to-peer '
  + 'network, not directly through Anthropic. Environment metadata comes from the Claude client '
  + 'infrastructure and may not describe the model actually serving the conversation.'

/**
 * Claude Desktop tells the model it is the Claude model its picker id belongs
 * to ("powered by Sonnet 5.5"), so a network model would otherwise call
 * itself that. The note names what actually serves the request: the picked
 * network model, tagged [Antseed], or Antseed Auto, whose model is the one
 * selected in the AI VPN and is only chosen after this note is written.
 */
function routingNote(served: ClaudeDesktopModel | null): string {
  const ignoreClaude = 'Any earlier statement that you are a Claude model, or that names a Claude model id '
    + '(such as claude-fable-5 or claude-auto), describes the Claude client\'s model slot, not you.'
  if (!served) {
    return `${ROUTING_NOTE} In this conversation you are ${AUTO_LABEL}: Antseed serves the model selected in the `
      + `Antseed AI VPN, so the exact model is not known here. ${ignoreClaude} When asked which model you are, `
      + `say you are ${AUTO_LABEL}, running the model selected in the Antseed AI VPN.`
  }
  const name = `${served.label} [Antseed]`
  return `${ROUTING_NOTE} In this conversation you are ${name} (model id: ${served.model}), served through Antseed. `
    + `${ignoreClaude} When asked which model you are, answer ${name}.`
}

/** Appended as the last system block so earlier prompt-cache breakpoints stay valid. */
function appendRoutingNote(request: Record<string, unknown>, served: ClaudeDesktopModel | null): void {
  const note = routingNote(served)
  const system = request['system']
  if (system === undefined || system === null) {
    request['system'] = note
  } else if (typeof system === 'string') {
    request['system'] = `${system}\n\n${note}`
  } else if (Array.isArray(system)) {
    request['system'] = [...system, { type: 'text', text: note }]
  }
}
