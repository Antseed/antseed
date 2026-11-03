/**
 * Whether an upstream error means its account is out of credit (a billing
 * problem the operator fixes by topping up), not a model, rate or request
 * fault: HTTP 402, or an error that says so in the words upstreams use
 * (DeepInfra "positive balance", OpenAI `insufficient_quota`, Anthropic
 * "credit balance is too low", OpenRouter "insufficient credits").
 * A per-minute quota ("exceeded your current quota" with RESOURCE_EXHAUSTED)
 * is a rate limit, not credit.
 */
const OUT_OF_CREDIT = /\b(?:positive balance|insufficient[_ ](?:balance|credits?|funds)|insufficient_quota|billing_hard_limit_reached|credit balance is too low|out of credits?)\b/i;

export function isUpstreamOutOfCredit(statusCode: number | null | undefined, text: string | null | undefined): boolean {
  return statusCode === 402 || (typeof text === 'string' && OUT_OF_CREDIT.test(text));
}

/**
 * The same for a buyer's request: a 400 is a validation error that can echo
 * the buyer's own input, so only a 402 or an error status the buyer cannot
 * shape by its input (401, 403, 429, 5xx) is read as the account.
 */
export function isLiveResponseOutOfCredit(statusCode: number, text: string): boolean {
  return statusCode === 402 || (statusCode !== 400 && statusCode !== 404 && statusCode !== 422 && statusCode >= 401 && isUpstreamOutOfCredit(null, text));
}
