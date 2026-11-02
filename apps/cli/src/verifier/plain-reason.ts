/**
 * Plain-language reasons for grey ("tried, not submitted") and yellow ("inconclusive") cells in the
 * epoch overview. Kept word-for-word in line with AntScan's `skip-reason.ts`, so an auditor's local
 * overview and the public explorer explain the same result the same way.
 */
export interface PlainReason {
  headline: string
  detail: string
}

const MONEY = String.raw`\$?([\d.]+)`

/** "$16.999785" → "$17", "$7.13" → "$7.13", "$5.5" → "$5.50". */
export function formatPerMillion(value: string | number): string {
  const amount = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(amount)) return `$${value}`
  const rounded = Math.round(amount * 100) / 100
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`
}

const pricePair = (input: string, output: string): string =>
  `${formatPerMillion(input)} in / ${formatPerMillion(output)} out`

function upstreamMessage(reason: string): string | null {
  const match = /"message"\s*:\s*"([^"]+)"/.exec(reason)
  if (!match) return null
  return match[1]!.replace(/\s*For assistance.*$/i, '').replace(/\.$/, '')
}

/** Why a seller was tried but not audited or not submitted, from the published `excluded[].reason` text. */
export function explainSkipReason(reason: string, modelLabel?: string): PlainReason {
  const text = reason.trim()

  const reference = new RegExp(
    `priced ${MONEY}\\s*/\\s*${MONEY}.*?above the (.+?) reference ${MONEY}\\s*/\\s*${MONEY}`, 'i',
  ).exec(text)
  if (reference) {
    const [, input, output, model, refInput, refOutput] = reference as unknown as string[]
    return {
      headline: "Not audited: the auditor won't pay this price",
      detail: `This seller charges ${pricePair(input!, output!)} per 1M tokens. `
        + `The auditor pays at most the upstream price, ${pricePair(refInput!, refOutput!)} for ${model}.`,
    }
  }

  if (/close call waiting for extra questions/i.test(text)) {
    return {
      headline: 'Not submitted yet: close call',
      detail: 'The first check was too close to call, so the auditor asks the seller a second set of fresh questions '
        + 'and decides on both together. That second set has not run yet, so nothing was recorded on-chain.',
    }
  }

  if (/DIFF not confirmed/i.test(text)) {
    return {
      headline: 'Not submitted: wrong-model result not confirmed',
      detail: "The answers didn't match, but the auditor couldn't run the confirming recheck, so nothing was recorded on-chain.",
    }
  }

  if (/reputation .* below/i.test(text)) {
    return { headline: 'Not audited: reputation too low', detail: "The seller's reputation is below the auditor's minimum." }
  }

  if (/response.?auth|ResponseAuth/i.test(text)) {
    return {
      headline: "Not audited: answers aren't signed",
      detail: "The seller doesn't sign its responses, so its answers can't be used as evidence.",
    }
  }

  if (/unsupported .*feature|request profile|canonical request/i.test(text)) {
    return {
      headline: 'Not audited: request format not supported',
      detail: "The seller rejected the standard audit request, so its answers couldn't be compared.",
    }
  }

  if (/pinned peer could not complete|transport|timed? ?out|unavailable|rate.?limit/i.test(text)) {
    const message = upstreamMessage(text)
    return {
      headline: "Not audited: the seller's requests failed",
      detail: message ? `The seller returned an error: “${message}”.` : "The seller didn't answer the audit requests successfully.",
    }
  }

  if (/not advertised|stale model/i.test(text)) {
    return {
      headline: 'Not audited: model no longer offered',
      detail: `The seller stopped advertising ${modelLabel ?? 'this model'} before it could be audited.`,
    }
  }

  return { headline: 'Not audited', detail: text }
}

/** What the auditor saw when an audit could not decide (verdict UNDETERMINED). */
export interface InconclusiveInput {
  code?: string | null
  summary?: string | null
  /** Verdict of the recheck on fresh probes, when the first check said DIFF. */
  recheckVerdict?: string | null
  answered?: number | null
  asked?: number | null
}

const INCONCLUSIVE_BY_CODE: Record<string, PlainReason> = {
  transport_error: {
    headline: "Inconclusive: the seller's connection failed",
    detail: 'Too many audit requests failed to reach the seller or broke off mid-answer, so there were too few answers to decide.',
  },
  deadline_exceeded: {
    headline: 'Inconclusive: the seller was too slow',
    detail: 'The audit ran out of time before the seller answered enough questions to decide.',
  },
  payment_lock_timeout: {
    headline: "Inconclusive: payment couldn't be set up in time",
    detail: "The auditor couldn't open a payment channel with the seller in time, so most questions were never sent.",
  },
  rate_limited: {
    headline: 'Inconclusive: the seller refused too many requests',
    detail: 'The seller rate-limited the audit, so too few questions were answered to decide.',
  },
  response_auth_invalid: {
    headline: "Inconclusive: answers weren't validly signed",
    detail: "Some answers came without a valid seller signature, so they can't be used as evidence.",
  },
  response_auth_missing: {
    headline: "Inconclusive: answers weren't signed",
    detail: "Some answers came without a seller signature, so they can't be used as evidence.",
  },
  request_timeout: {
    headline: 'Inconclusive: the seller was too slow',
    detail: 'Too many audit requests timed out before the seller answered, so there were too few answers to decide.',
  },
  temporarily_unavailable: {
    headline: 'Inconclusive: the seller was unavailable',
    detail: 'The seller was temporarily unavailable during the audit, so too few questions were answered to decide.',
  },
  upstream_credentials_invalid: {
    headline: "Inconclusive: the seller's upstream key failed",
    detail: "The seller's own upstream provider rejected its credentials, so most questions went unanswered.",
  },
  request_profile_incompatible: {
    headline: 'Inconclusive: request format not supported',
    detail: "The seller rejected the standard audit request, so its answers couldn't be compared.",
  },
  malformed_output: {
    headline: "Inconclusive: answers couldn't be read",
    detail: 'Too many answers were empty or not in the requested format, so there were too few readable answers to decide.',
  },
  missing_response_auth: {
    headline: "Inconclusive: answers weren't signed",
    detail: "Some answers came without a seller signature, so they can't be used as evidence.",
  },
  empty_response: {
    headline: 'Inconclusive: the seller gave empty answers',
    detail: 'Too many answers were empty or unreadable to decide.',
  },
}

/** Plain-language reason an audit came back inconclusive. */
export function explainInconclusive(input: InconclusiveInput): PlainReason {
  const answered = input.answered !== null && input.answered !== undefined && input.asked
    ? ` The seller answered ${input.answered} of ${input.asked} questions.`
    : ''
  if (input.recheckVerdict === 'SAME') {
    return {
      headline: 'Inconclusive: the recheck passed',
      detail: "The first check didn't match the official model, but a recheck on fresh questions did, so it isn't counted as a wrong model.",
    }
  }
  if (input.recheckVerdict === 'UNDETERMINED') {
    return {
      headline: 'Inconclusive: wrong model not confirmed',
      detail: "The first check didn't match the official model, but the recheck on fresh questions couldn't decide, "
        + `so it isn't counted as a wrong model.${answered}`,
    }
  }
  const known = input.code ? INCONCLUSIVE_BY_CODE[input.code] : undefined
  if (known) return { headline: known.headline, detail: `${known.detail}${answered}` }
  const summary = input.summary?.trim()
  if (summary && /response.?auth/i.test(summary)) {
    const missing = INCONCLUSIVE_BY_CODE['response_auth_missing']!
    return { headline: missing.headline, detail: `${missing.detail}${answered}` }
  }
  return {
    headline: 'Inconclusive',
    detail: summary ? `${summary}${answered ? `.${answered}` : ''}` : `The audit couldn't decide.${answered}`,
  }
}
