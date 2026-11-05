/**
 * Fallback for writing candidate questions, an AntSeed addition to the KBF reference code.
 *
 * Questions are written ("Generate exactly 20 facts ...") with the same thinking setting the
 * bank records for asking them. Some models answer short questions cleanly with thinking turned
 * off but, asked for a long list, think out loud in the answer until the token limit and return
 * no list (Kimi K3.1 Pro on OpenRouter did this for half its batches). For such an answer only,
 * the batch is asked once more with a little thinking allowed. Questions written that way are then
 * stability-checked, contrasted, self-tested and audited with the recorded setting, exactly like
 * every other question, so nothing measured or scored changes.
 */
import type { ThinkingDiscoveryStrategy } from './thinking-suppression.js'

/** The first answers of a build that decide whether new batches go straight to the fallback. */
export const CANDIDATE_WRITING_TRIAL_ANSWERS = 3
/** Rambling answers among the trial answers that switch the rest of the build to the fallback. */
export const CANDIDATE_WRITING_SWITCH_THRESHOLD = 2
/** Share of `max_tokens` an answer must use to count as having run out of room. */
const OUT_OF_ROOM_SHARE = 0.95

/**
 * An answer rambled when it used (almost) all its tokens and still gave fewer than half the
 * requested facts. A short refusal, a filtered answer or a list in another format is not rambling.
 */
export function isRamblingCandidateAnswer(input: {
  factCount: number
  requestedCount: number
  outputTokens: number
  maxTokens: number
}): boolean {
  return input.factCount * 2 < input.requestedCount && input.outputTokens >= input.maxTokens * OUT_OF_ROOM_SHARE
}

/** Recorded in `generator.params.candidateWriting` when any answer rambled during the build. */
export interface CandidateWritingRecordV1 {
  version: 1
  /** Thinking setting used to write the questions when the recorded one rambled; null when none applies. */
  fallbackStrategy: ThinkingDiscoveryStrategy | null
  /** Rambling answers seen with the recorded setting. */
  ramblingAnswers: number
  /** Batches asked again with the fallback after a rambling answer. */
  retriedBatches: number
  /** Batches sent straight to the fallback after the trial answers rambled. */
  directBatches: number
  /** Fallback answers that gave a usable list. */
  recoveredBatches: number
  /** Set when the endpoint refused the fallback; writing then stays on the recorded setting. */
  fallbackRefused?: string
}

export class CandidateWritingPolicy {
  private fallback: ThinkingDiscoveryStrategy | null
  private trialStarted = 0
  private trialFinished = 0
  private trialRambling = 0
  private switched = false
  private readonly trialDone: Promise<void>
  private resolveTrial!: () => void
  private readonly record: CandidateWritingRecordV1

  constructor(fallback: ThinkingDiscoveryStrategy | null, private readonly log?: (message: string) => void) {
    this.fallback = fallback
    this.record = { version: 1, fallbackStrategy: fallback, ramblingAnswers: 0, retriedBatches: 0, directBatches: 0, recoveredBatches: 0 }
    this.trialDone = new Promise((resolve) => { this.resolveTrial = resolve })
  }

  /**
   * Starts a batch. The build's first batches are the trial and use the recorded setting; later
   * batches wait for the trial answers, then use the fallback if the trial rambled. Without a
   * fallback nothing waits and every batch uses the recorded setting, as before.
   */
  async beginBatch(): Promise<{ trial: boolean; strategy: ThinkingDiscoveryStrategy | null }> {
    if (!this.fallback) return { trial: false, strategy: null }
    if (this.trialStarted < CANDIDATE_WRITING_TRIAL_ANSWERS) {
      this.trialStarted += 1
      return { trial: true, strategy: null }
    }
    await this.trialDone
    if (!this.switched || !this.fallback) return { trial: false, strategy: null }
    this.record.directBatches += 1
    return { trial: false, strategy: this.fallback }
  }

  /** Ends a trial batch, whatever its outcome, so waiting batches can start. */
  endTrialBatch(): void {
    this.trialFinished += 1
    if (this.trialFinished >= CANDIDATE_WRITING_TRIAL_ANSWERS) this.resolveTrial()
  }

  /**
   * Records an answer written with the recorded setting. Returns the strategy to ask the batch
   * again with, or null to keep the answer as it is.
   */
  observeRecordedAnswer(rambled: boolean, trial: boolean): ThinkingDiscoveryStrategy | null {
    if (rambled) this.record.ramblingAnswers += 1
    if (trial && rambled) {
      this.trialRambling += 1
      if (!this.switched && this.fallback && this.trialRambling >= CANDIDATE_WRITING_SWITCH_THRESHOLD) {
        this.switched = true
        this.log?.(
          `${this.trialRambling} of the first ${CANDIDATE_WRITING_TRIAL_ANSWERS} question-writing answers ran out of tokens `
          + `without a list; writing the rest of this build's questions with '${this.fallback}' `
          + '(asking and scoring keep the recorded setting)',
        )
      }
    }
    if (!rambled || !this.fallback) return null
    this.record.retriedBatches += 1
    return this.fallback
  }

  /** Records whether a fallback answer gave a usable list. */
  observeFallbackAnswer(usable: boolean): void {
    if (usable) this.record.recoveredBatches += 1
  }

  /** The endpoint refused the fallback: stop using it for the rest of the build. */
  refuseFallback(reason: string): void {
    if (!this.fallback) return
    this.log?.(`question writing: '${this.fallback}' was refused (${reason}); keeping the recorded setting`)
    this.record.fallbackRefused = reason.slice(0, 300)
    this.fallback = null
    this.switched = false
  }

  /** What happened, for the reference; null when no answer rambled. */
  summary(): CandidateWritingRecordV1 | null {
    return this.record.ramblingAnswers > 0 || this.record.fallbackRefused ? { ...this.record } : null
  }
}

/**
 * The fallback for a route: a little thinking (`reasoning.effort: "minimal"`), only on OpenRouter
 * routes whose recorded setting turns thinking off. Routes that already think, Anthropic Messages
 * routes and other APIs get none and write questions exactly as before.
 */
export function candidateWritingFallback(route: {
  type: string
  baseUrl: string
  protocol?: string
  requestOverrides: Record<string, unknown>
  assistantPrefill?: string
}): ThinkingDiscoveryStrategy | null {
  if (route.type !== 'direct' || route.protocol === 'anthropic-messages' || route.assistantPrefill) return null
  let host: string
  try {
    host = new URL(route.baseUrl).hostname
  } catch {
    return null
  }
  if (host !== 'openrouter.ai' && !host.endsWith('.openrouter.ai')) return null
  const overrides = route.requestOverrides
  const reasoning = overrides.reasoning as { effort?: unknown } | undefined
  const thinkingOff = overrides.reasoning_effort === 'none' || reasoning?.effort === 'none'
  return thinkingOff ? 'reasoning-effort-minimal' : null
}
