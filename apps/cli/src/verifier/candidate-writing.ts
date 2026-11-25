/**
 * Fallback for writing candidate questions, an Antseed addition to the KBF reference code.
 *
 * Questions are written ("Generate exactly 20 facts ...") with the same thinking setting the
 * bank records for asking them. Some models answer short questions cleanly with thinking turned
 * off but, asked for a long list, think out loud in the answer until the token limit and return
 * no list (Kimi K3.1 Pro on OpenRouter did this for half its batches). For such an answer only,
 * the batch is asked once more with a little thinking allowed. Questions written that way are then
 * stability-checked, contrasted, self-tested and audited with the recorded setting, exactly like
 * every other question, so nothing measured or scored changes.
 */
import { thinkingAttemptReachedZero } from '@antseed/fingerprints'
import type { ThinkingDiscoveryAttemptV1, ThinkingDiscoveryStrategy } from './thinking-suppression.js'

/** Output limit of a question-writing request, as the KBF reference code asks for a list. */
export const CANDIDATE_WRITING_MAX_TOKENS = 6000
/**
 * Output limit of a question-writing request when the model's discovery found nothing that turns its thinking off: room
 * to think and still write the list. Gemini 4 Neon thinks through all 6000 tokens before writing anything on most
 * batches with the setting that thought least; 16000 fits its thinking and the list.
 */
export const CANDIDATE_WRITING_THINKING_MAX_TOKENS = 16000

/**
 * The output limit for question writing, from the model's own thinking discovery (`generator.params.thinkingDiscovery
 * .target`): the larger limit when the last attempt of the setting it chose still thought (a least-thinking pick, or
 * `bare` that thought), else the usual one. A bank without a stored discovery keeps the usual limit. Only writing
 * changes: the questions sellers are asked, the answer limits and scoring do not.
 */
export function candidateWritingMaxTokens(
  target: { strategy: ThinkingDiscoveryStrategy; attempts: readonly ThinkingDiscoveryAttemptV1[] } | undefined,
): number {
  if (!target) return CANDIDATE_WRITING_MAX_TOKENS
  const attempts = target.attempts.filter((attempt) => attempt?.strategy === target.strategy)
  return thinkingAttemptReachedZero(attempts.at(-1)) ? CANDIDATE_WRITING_MAX_TOKENS : CANDIDATE_WRITING_THINKING_MAX_TOKENS
}

/** The first answers of a build that decide whether new batches go straight to the fallback. */
export const CANDIDATE_WRITING_TRIAL_ANSWERS = 3
/** Rambling answers among the trial answers that switch the rest of the build to the fallback. */
export const CANDIDATE_WRITING_SWITCH_THRESHOLD = 2
/**
 * Fallback answers that, all unusable, end the fallback for the rest of the build: when a little thinking also runs out of
 * tokens (DeepSeek V4 Pro on its pinned host thought through all 6000 with it, 45 times in one build), every later batch
 * would pay for it twice.
 */
export const CANDIDATE_WRITING_FALLBACK_TRIAL_ANSWERS = 3
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
  /** Set when the fallback's first answers gave no usable list either; writing then stays on the recorded setting. */
  fallbackAbandoned?: string
  /** The writing output limit, when it is not `CANDIDATE_WRITING_MAX_TOKENS` (`candidateWritingMaxTokens`). */
  maxTokens?: number
}

export class CandidateWritingPolicy {
  private fallback: ThinkingDiscoveryStrategy | null
  private trialStarted = 0
  private trialFinished = 0
  private trialRambling = 0
  private fallbackAnswers = 0
  private switched = false
  private readonly trialDone: Promise<void>
  private resolveTrial!: () => void
  private readonly record: CandidateWritingRecordV1

  constructor(
    fallback: ThinkingDiscoveryStrategy | null,
    private readonly log?: (message: string) => void,
    /** Output limit of every writing request of the build (`candidateWritingMaxTokens`). */
    readonly maxTokens: number = CANDIDATE_WRITING_MAX_TOKENS,
  ) {
    this.fallback = fallback
    this.record = {
      version: 1, fallbackStrategy: fallback, ramblingAnswers: 0, retriedBatches: 0, directBatches: 0, recoveredBatches: 0,
      ...(maxTokens !== CANDIDATE_WRITING_MAX_TOKENS ? { maxTokens } : {}),
    }
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

  /** Records whether a fallback answer gave a usable list; ends the fallback when its first answers all gave none. */
  observeFallbackAnswer(usable: boolean): void {
    this.fallbackAnswers += 1
    if (usable) this.record.recoveredBatches += 1
    if (this.fallback && this.record.recoveredBatches === 0 && this.fallbackAnswers >= CANDIDATE_WRITING_FALLBACK_TRIAL_ANSWERS) {
      const reason = `its first ${this.fallbackAnswers} answers gave no usable list`
      this.log?.(`question writing: '${this.fallback}' did not help (${reason}); keeping the recorded setting`)
      this.record.fallbackAbandoned = reason
      this.fallback = null
      this.switched = false
    }
  }

  /** The endpoint refused the fallback: stop using it for the rest of the build. */
  refuseFallback(reason: string): void {
    if (!this.fallback) return
    this.log?.(`question writing: '${this.fallback}' was refused (${reason}); keeping the recorded setting`)
    this.record.fallbackRefused = reason.slice(0, 300)
    this.fallback = null
    this.switched = false
  }

  /** What happened, for the reference; null when no answer rambled and writing used the usual limit. */
  summary(): CandidateWritingRecordV1 | null {
    return this.record.ramblingAnswers > 0 || this.record.fallbackRefused || this.record.fallbackAbandoned
      || this.record.maxTokens !== undefined ? { ...this.record } : null
  }
}

/**
 * The fallback for a route: a little thinking (`reasoning.effort: "minimal"`), only on OpenRouter
 * routes whose recorded setting turns thinking off, or sets no thinking at all (`bare`: the model
 * ignored every way of turning it off). A `bare` model thinks as long as it likes, and on a long list
 * it can spend every token thinking and return no text: GLM 5.3 on its maker's endpoint did this for
 * every batch, while `minimal` cut its thinking about fourfold on audit questions. Routes with
 * another thinking setting, Anthropic Messages routes and other APIs get none and write questions
 * exactly as before.
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
  const noThinkingSetting = !THINKING_SETTINGS.some((key) => key in overrides)
  return thinkingOff || noThinkingSetting ? 'reasoning-effort-minimal' : null
}

/** Request fields that set thinking on some route: a route with none of them leaves thinking to the model. */
const THINKING_SETTINGS = ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking', 'chat_template_kwargs'] as const
