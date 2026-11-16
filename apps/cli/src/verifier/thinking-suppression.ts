/**
 * Thinking suppression discovered per endpoint, as in the KBF reference code
 * (`discover_thinking_strategy`). The implementation lives in `@antseed/fingerprints`
 * so the CLI verifier (reference builds and seller audits) and `@antseed/model-verifier`
 * share it; this module keeps the CLI's import path.
 */
export {
  THINKING_DISCOVERY_MAX_TOKENS,
  THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS,
  THINKING_DISCOVERY_PROBES,
  THINKING_DISCOVERY_STRATEGIES,
  THINKING_DISCOVERY_TIMEOUT_MS,
  THINKING_FALLBACK_MAX_TOKENS,
  THINKING_FALLBACK_TOKEN_MULTIPLIER,
  ThinkingDiscoveryError,
  countDiscoveryAnswers,
  discoverThinkingSuppression,
  thinkingStrategyRequest,
  type ThinkingDiscoveryAttemptV1,
  type ThinkingDiscoveryProbe,
  type ThinkingDiscoveryResultV1,
  type ThinkingDiscoveryStrategy,
  type ThinkingStrategyRequest,
} from '@antseed/fingerprints'
