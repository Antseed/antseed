/**
 * Thinking suppression discovered per endpoint, as in the KBF reference code
 * (`discover_thinking_strategy`). The implementation lives in `@antseed/fingerprints`
 * so the CLI verifier (reference builds and seller audits) and `@antseed/model-verifier`
 * share it; this module keeps the CLI's import path.
 */
export {
  CHAT_THINKING_STRATEGIES,
  THINKING_LEVELS,
  THINKING_REFERENCE_FIRST_RULE,
  THINKING_TABLE_RULE,
  chatStrategyForLevel,
  checkThinkingSetting,
  referenceStrategyForLevel,
  thinkingLevelOf,
  type ThinkingLevel,
  THINKING_DISCOVERY_MAX_TOKENS,
  THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS,
  THINKING_DISCOVERY_PROBES,
  THINKING_DISCOVERY_RULE,
  THINKING_DISCOVERY_RULES,
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
  type ThinkingDiscoveryRuleId,
  type ThinkingDiscoveryStrategy,
  type ThinkingStrategyRequest,
} from '@antseed/fingerprints'
