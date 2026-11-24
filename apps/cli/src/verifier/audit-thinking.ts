import {
  KBF_THINKING_PREFILL,
  KBF_THINKING_SUPPRESSION_FIELDS,
  thinkingAttemptReachedZero,
  THINKING_DISCOVERY_STRATEGIES,
  THINKING_REFERENCE_EQUIVALENTS,
  canonicalJsonStringify,
  isReferenceFirstStrategy,
  kbfTargetThinkingSuppression,
  referenceEndpointRequest,
  thinkingStrategyRequest,
  type KbfReferenceV1,
  type KbfThinkingSuppression,
  type ReferenceReasoningStrategy,
  type ThinkingDiscoveryAttemptV1,
  type ThinkingDiscoveryStrategy,
} from '@antseed/fingerprints'

/**
 * How every test of an audit asks an endpoint not to think: one vocabulary, one way to choose, one recheck.
 *
 * The questions (KBF) set the pattern, as the KBF reference code does for every endpoint it queries: thinking discovery
 * finds each endpoint's own setting (`discoverThinkingSuppression`), the seller's once per run, the reference's when its
 * bank is built, and each side is asked with its own. A seller's discovery tries the reference's setting first
 * (`referenceDiscoveryStrategy`), so the two sides are asked the same way wherever the seller takes it. A test declares what each side needs (`TestThinking`); the audit
 * resolves it (`resolveThinking`) and hands the test the settings to send; the test's validator holds every signed
 * request to the setting its record names (`assertRequestCarries`). No test carries a setting table or a discovery of
 * its own: a fixed body (`fixed`) is a test's eval-measured fallback, used only where its declaration says so.
 */

/** One way of asking an endpoint not to think, as a value: the exact fields it adds to a request. */
export interface ThinkingSetting {
  /**
   * Where it comes from: the seller's own discovery, the bank's (the reference's discovery when its question set was
   * built, also what a seller gets when its own discovery failed), a test's own fixed body, or nothing at all.
   */
  source: 'discovery' | 'bank' | 'fixed' | 'none'
  /** The strategy's name, discovery's or the one the bank recorded; null for a fixed body or none. */
  strategy: ReferenceReasoningStrategy | null
  /** The request members it sets. */
  overrides: Readonly<Record<string, unknown>>
  /** The assistant turn it appends (`prefill` only). */
  assistantPrefill?: typeof KBF_THINKING_PREFILL
}

/** No thinking field at all: the request is the text alone. */
export const NO_THINKING_SETTING: ThinkingSetting = Object.freeze({ source: 'none', strategy: null, overrides: Object.freeze({}) })

/** What the seller's side of a test needs. */
export type SellerThinkingNeed =
  /** No thinking field: the request must be the text alone (the tokenizer pre-check). */
  | 'bare'
  /** The seller's own discovered setting, as for its questions; the bank's when its discovery failed. Makes the audit run discovery. */
  | 'own'
  /** The test's own fixed body for the model (`TestThinking.fixed`), the same for every seller. */
  | 'fixed'

/** What the reference's side of a test needs. */
export type ReferenceThinkingNeed =
  /** The bank's own discovered setting (the reference oracle's bank route sends it). */
  | 'bank'
  /** The test's own fixed body for the model. */
  | 'fixed'
  /** The bank's setting where the bank's discovery reached 0 reasoning tokens with it; else the test's fixed body. */
  | { bank: 'if-zero'; otherwise: 'fixed' }

/** What the crowd's side of a test needs: the model's other sellers. */
export type CrowdThinkingNeed = 'bare' | 'reference'

export interface ThinkingNeeds<Seller extends SellerThinkingNeed = SellerThinkingNeed> {
  seller: Seller
  reference: ReferenceThinkingNeed
  /** For a test with a crowd. */
  crowd?: CrowdThinkingNeed
}

/**
 * A test's declaration of the thinking settings it sends: required of every test (`RecordCheck.thinking`, and the
 * questions' `QUESTIONS_CHECK.thinking`), so the audit knows from one list what each test needs, and no test carries
 * a setting table or a discovery of its own.
 */
export interface TestThinking<Seller extends SellerThinkingNeed = SellerThinkingNeed> {
  needs: ThinkingNeeds<Seller>
  /** The test's own body for the model; given when a side says `fixed`. Part of the test's rule, so it stays with the test. */
  fixed?(model: string): ThinkingSetting
  /** Why, in one line. */
  why: string
}

/** The settings a test's requests carry in one audit, by side. */
export interface ResolvedThinking {
  seller: ThinkingSetting
  reference: ThinkingSetting
  /** Null for a test without a crowd. */
  crowd: ThinkingSetting | null
}

/** The setting a discovery strategy sends: its fields and its prefill, without the token budget of `bare-expanded`. */
export function strategySetting(strategy: ThinkingDiscoveryStrategy): ThinkingSetting {
  const request = thinkingStrategyRequest(strategy)
  return {
    source: 'discovery',
    strategy,
    overrides: request.overrides,
    ...(request.assistantPrefill ? { assistantPrefill: request.assistantPrefill } : {}),
  }
}

/**
 * The bank's own setting: the thinking fields of the request its reference was asked with, and its prefill
 * (`kbfTargetThinkingSuppression`). Never the bank's other endpoint quirks (omitted fields, provider pins).
 */
export function bankSetting(bank: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>): ThinkingSetting {
  const suppression = kbfTargetThinkingSuppression(bank)
  if (!suppression) return { source: 'bank', strategy: referenceEndpointRequest(bank)?.reasoningStrategy ?? null, overrides: {} }
  return {
    source: 'bank',
    strategy: suppression.strategy,
    overrides: suppression.overrides,
    ...(suppression.assistantPrefill ? { assistantPrefill: suppression.assistantPrefill } : {}),
  }
}

/**
 * Whether the bank's own discovery reached 0 reasoning tokens with the setting it recorded: its last attempt of that
 * strategy (`generator.params.thinkingDiscovery.target`). False for a bank without a stored discovery.
 */
export function bankReachedZero(bank: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>): boolean {
  const strategy = referenceEndpointRequest(bank)?.reasoningStrategy
  const discovery = bank.generator?.params?.['thinkingDiscovery'] as { target?: { strategy?: unknown; attempts?: unknown } } | undefined
  const target = discovery?.target
  if (!strategy || !target || target.strategy !== strategy || !Array.isArray(target.attempts)) return false
  const attempts = (target.attempts as ThinkingDiscoveryAttemptV1[]).filter((attempt) => attempt?.strategy === strategy)
  // Read with discovery's own predicate (`thinkingAttemptReachedZero`), so the audit and discovery never drift.
  return thinkingAttemptReachedZero(attempts.at(-1))
}

/**
 * The reference's setting, which a seller's discovery tries first (`THINKING_DISCOVERY_RULE`): the strategy the bank's own
 * discovery chose on the genuine endpoint (`generator.params.thinkingDiscovery.target`), the one its reference was asked
 * with. Null for a bank without a stored discovery, a `bare` or `bare-expanded` bank, and an older strategy name: the
 * seller's discovery then runs the order alone.
 */
export function referenceDiscoveryStrategy(bank: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>): ThinkingDiscoveryStrategy | null {
  const strategy = referenceEndpointRequest(bank)?.reasoningStrategy
  const discovery = bank.generator?.params?.['thinkingDiscovery'] as { target?: { strategy?: unknown } } | undefined
  if (!discovery?.target || discovery.target.strategy !== strategy || !isReferenceFirstStrategy(strategy)) return null
  return strategy
}

/** Whether two settings ask the same way: the same thinking fields with the same values and the same prefill, whatever their source. */
export function sameRequestSetting(left: ThinkingSetting, right: ThinkingSetting): boolean {
  const shape = (setting: ThinkingSetting) => canonicalJsonStringify({ overrides: setting.overrides, prefill: setting.assistantPrefill ?? null })
  return shape(left) === shape(right)
}

/**
 * Whether a seller asked with `seller` was asked the way the reference was (`reference`): the same request, or the
 * nearest equivalent its discovery may send for it (`THINKING_REFERENCE_EQUIVALENTS`: `"low"` for `"minimal"`), from
 * whatever source the reference's setting came (its bank's, or a test's fixed body that sends the same).
 */
export function askedAsReference(seller: ThinkingSetting, reference: ThinkingSetting): boolean {
  if (sameRequestSetting(seller, reference)) return true
  return Object.entries(THINKING_REFERENCE_EQUIVALENTS).some(([from, to]) => to !== undefined
    && sameRequestSetting(reference, strategySetting(from as ThinkingDiscoveryStrategy))
    && sameRequestSetting(seller, strategySetting(to)))
}

/** A seller's own setting: its discovery's, or the bank's when it has none (discovery not run, or failed). */
export function sellerOwnSetting(
  discovery: { strategy: ThinkingDiscoveryStrategy | null } | null,
  bank: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>,
): ThinkingSetting {
  return discovery && discovery.strategy !== null ? strategySetting(discovery.strategy) : bankSetting(bank)
}

/** Whether a test's declaration needs the seller's own discovery. */
export function needsSellerDiscovery(test: Pick<TestThinking, 'needs'>): boolean {
  return test.needs.seller === 'own'
}

/** The settings a test's declaration gives in one audit. Throws when a side says `fixed` and the test gives no body. */
export function resolveThinking(test: TestThinking, input: {
  model: string
  bank: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>
  /** The seller's discovery in this audit; null when none ran. */
  discovery: { strategy: ThinkingDiscoveryStrategy | null } | null
}): ResolvedThinking {
  const fixed = (): ThinkingSetting => {
    if (!test.fixed) throw new Error(`a test that declares a fixed thinking setting gives none (${test.why})`)
    return test.fixed(input.model)
  }
  const seller = test.needs.seller === 'bare' ? NO_THINKING_SETTING
    : test.needs.seller === 'fixed' ? fixed()
      : sellerOwnSetting(input.discovery, input.bank)
  const need = test.needs.reference
  const reference = need === 'bank' ? bankSetting(input.bank)
    : need === 'fixed' ? fixed()
      : bankReachedZero(input.bank) ? bankSetting(input.bank) : fixed()
  const crowd = test.needs.crowd === undefined ? null : test.needs.crowd === 'bare' ? NO_THINKING_SETTING : bankSetting(input.bank)
  return { seller, reference, crowd }
}

/**
 * A setting as the older request builders take it (`KbfThinkingSuppression`): null when it sets nothing, so a request
 * built from it is byte for byte the one those builders always made.
 */
export function asSuppression(setting: ThinkingSetting): KbfThinkingSuppression | null {
  if (Object.keys(setting.overrides).length === 0 && !setting.assistantPrefill) return null
  return {
    strategy: setting.strategy,
    overrides: { ...setting.overrides },
    ...(setting.assistantPrefill ? { assistantPrefill: setting.assistantPrefill } : {}),
  }
}

/** The request members a thinking setting can set: what a recheck looks at (`KBF_THINKING_SUPPRESSION_FIELDS`). */
export const THINKING_MEMBERS: readonly string[] = KBF_THINKING_SUPPRESSION_FIELDS

/** Every strategy a seller's discovery may keep: the order, the reference's nearest equivalents, and `bare-expanded`. */
const DISCOVERY_STRATEGIES: readonly ThinkingDiscoveryStrategy[] = [
  ...THINKING_DISCOVERY_STRATEGIES,
  ...Object.values(THINKING_REFERENCE_EQUIVALENTS).filter((strategy): strategy is ThinkingDiscoveryStrategy => strategy !== undefined),
  'bare-expanded',
]

/** The settings discovery may choose, by member and value, and its prefills: what a question batch may carry. */
const DISCOVERY_SETTINGS = DISCOVERY_STRATEGIES.map((strategy) => thinkingStrategyRequest(strategy))
const KNOWN_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const byMember = new Map<string, Set<string>>()
  for (const setting of DISCOVERY_SETTINGS) {
    for (const [member, value] of Object.entries(setting.overrides)) {
      byMember.set(member, (byMember.get(member) ?? new Set()).add(canonicalJsonStringify(value)))
    }
  }
  return byMember
})()
const KNOWN_PREFILLS: ReadonlySet<string> = new Set(DISCOVERY_SETTINGS.flatMap((setting) => (setting.assistantPrefill ? [setting.assistantPrefill] : [])))

/** Whether a request member and its value are one discovery may send (`THINKING_DISCOVERY_STRATEGIES` and the equivalents). */
export function isDiscoveryMember(member: string, value: unknown): boolean {
  return KNOWN_MEMBERS.get(member)?.has(canonicalJsonStringify(value)) ?? false
}

/** Whether an assistant turn's text is a prefill discovery may send. */
export function isDiscoveryPrefill(text: string): boolean {
  return KNOWN_PREFILLS.has(text)
}

/**
 * Whether a stored setting is one a test's side may name: a discovery strategy with exactly its own fields, the bank's
 * (thinking members and the prefill only), the test's fixed body for the model, or none.
 */
export function isAllowedSetting(setting: unknown, allowed: { fixed?: ThinkingSetting; bank?: boolean; none?: boolean; discovery?: boolean }): setting is ThinkingSetting {
  if (!setting || typeof setting !== 'object') return false
  const value = setting as Partial<ThinkingSetting>
  if (!value.overrides || typeof value.overrides !== 'object' || Array.isArray(value.overrides)) return false
  if (value.assistantPrefill !== undefined && value.assistantPrefill !== KBF_THINKING_PREFILL) return false
  const same = (other: ThinkingSetting): boolean => canonicalJsonStringify(setting) === canonicalJsonStringify(other)
  switch (value.source) {
    case 'discovery':
      return allowed.discovery === true && typeof value.strategy === 'string'
        && (DISCOVERY_STRATEGIES as readonly string[]).includes(value.strategy)
        && same(strategySetting(value.strategy as ThinkingDiscoveryStrategy))
    case 'bank':
      return allowed.bank === true && Object.keys(value.overrides).every((member) => THINKING_MEMBERS.includes(member))
    case 'fixed':
      return allowed.fixed !== undefined && same(allowed.fixed)
    case 'none':
      return allowed.none === true && same(NO_THINKING_SETTING)
    default:
      return false
  }
}

/** The turns of a request in any shape the buyer proxy translates to: Chat and Messages `messages`, Responses `input`. */
function turnsOf(body: Record<string, unknown>): unknown[] {
  const turns = body['messages'] ?? body['input']
  return Array.isArray(turns) ? turns : []
}

/** The text of a turn: a string, or its text parts joined. */
function turnText(turn: unknown): string | null {
  if (!turn || typeof turn !== 'object') return null
  const content = (turn as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : null))
  return texts.every((part): part is string => part !== null) ? texts.join('') : null
}

/**
 * Whether a request carries exactly this setting: each thinking member it sets with its value, no other thinking member,
 * and its prefill as the last turn (and no prefill when it has none). Reads a parsed body.
 */
export function requestCarries(body: unknown, setting: ThinkingSetting): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const request = body as Record<string, unknown>
  const members = new Set([...THINKING_MEMBERS, ...Object.keys(setting.overrides)])
  for (const member of members) {
    const expected = setting.overrides[member]
    const actual = request[member]
    if (expected === undefined ? actual !== undefined : actual === undefined || canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) return false
  }
  const last = turnsOf(request).at(-1)
  const prefilled = !!last && typeof last === 'object' && (last as { role?: unknown }).role === 'assistant'
  if (!setting.assistantPrefill) return !prefilled || turnText(last) !== KBF_THINKING_PREFILL
  return prefilled && turnText(last) === setting.assistantPrefill
}

/** `requestCarries` on request bytes, for a validator: throws with `what` when the request does not carry the setting. */
export function assertRequestCarries(requestBody: Uint8Array | string, setting: ThinkingSetting, what: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof requestBody === 'string' ? requestBody : new TextDecoder().decode(requestBody))
  } catch {
    parsed = null
  }
  if (!requestCarries(parsed, setting)) throw new Error(`${what} does not carry the thinking setting its record names`)
}

/** A setting as one short text, for a log line or a reason. */
export function describeSetting(setting: ThinkingSetting): string {
  const fields = Object.keys(setting.overrides).length > 0 ? canonicalJsonStringify(setting.overrides) : ''
  const prefill = setting.assistantPrefill ? 'a prefill' : ''
  const what = [fields, prefill].filter(Boolean).join(' and ') || 'no thinking field'
  return `${setting.source}${setting.strategy ? ` ${setting.strategy}` : ''} (${what})`
}
