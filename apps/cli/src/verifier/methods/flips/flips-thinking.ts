import type { TestThinking } from '../../audit-thinking.js'
import { flipsFixedSetting } from './flips-score.js'

/**
 * FLIPS's thinking declaration (`RecordCheck.thinking`): the questions' principle on both sides.
 *
 * - The seller is asked with its own discovered setting, as for its questions, also when discovery only reached the
 *   setting that thinks least, and the bank's when its discovery failed. Its discovery tries the reference's setting
 *   first, so that is the reference's wherever the seller takes it; where it is not the reference's FLIPS setting, the
 *   seller could not be asked the way the reference was, and FLIPS has no result (`FLIPS_NOT_ASKED_AS_REFERENCE`). A
 *   seller that still reasons where the reference does not has no result by the reasoning-profile rule (`judgeFlips`).
 * - The reference is asked with its bank's discovered setting where that reached 0 reasoning tokens with it. Where it
 *   did not (a `bare` bank that thinks, DeepSeek V4 Pro's and Grok 4.7's), it gets the eval's switch for the model
 *   (`flipsFixedSetting`): a reference that thinks freely gives a profile no plain seller can match, and the eval's
 *   body is the one the calibration was fitted on.
 * - FLIPS keeps the eval's prompt, reply limit and temperature on both sides; only the switch is each side's own.
 */
export const FLIPS_THINKING: TestThinking = Object.freeze({
  needs: Object.freeze({ seller: 'own', reference: Object.freeze({ bank: 'if-zero', otherwise: 'fixed' }) }),
  fixed: flipsFixedSetting,
  why: 'each side with its own discovered switch, as the questions; the eval\'s switch only where the bank\'s still thinks',
}) as TestThinking
