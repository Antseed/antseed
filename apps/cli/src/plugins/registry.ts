export interface TrustedPlugin {
  name: string
  type: 'provider' | 'router' | 'verifier'
  description: string
  package: string
  /** Exact npm version for trusted verifier packages. */
  version?: string
}

export const TRUSTED_PROVIDER_PLUGINS: TrustedPlugin[] = [
  {
    name: 'anthropic',
    type: 'provider',
    description: 'Anthropic API provider (API key)',
    package: '@antseed/provider-anthropic',
  },
  {
    name: 'claude-code',
    type: 'provider',
    description: 'Claude Code keychain provider (testing only)',
    package: '@antseed/provider-claude-code',
  },
  {
    name: 'claude-oauth',
    type: 'provider',
    description: 'Claude OAuth provider (testing only)',
    package: '@antseed/provider-claude-oauth',
  },
  {
    name: 'openai',
    type: 'provider',
    description: 'OpenAI-compatible provider (OpenAI, Together, OpenRouter, API key)',
    package: '@antseed/provider-openai',
  },
  {
    name: 'openai-responses',
    type: 'provider',
    description: 'OpenAI Responses provider via Codex auth (testing only)',
    package: '@antseed/provider-openai-responses',
  },
  {
    name: 'local-llm',
    type: 'provider',
    description: 'Local LLM provider (Ollama, llama.cpp)',
    package: '@antseed/provider-local-llm',
  },
  {
    name: 'typesafe',
    type: 'provider',
    description: 'TypeSafe System One decision-model provider (API key)',
    package: '@antseed/provider-typesafe',
  },
]

export const TRUSTED_ROUTER_PLUGINS: TrustedPlugin[] = [
  {
    name: 'local',
    type: 'router',
    description: 'Local router for Claude Code, Codex',
    package: '@antseed/router-local',
  },
]

export const TRUSTED_VERIFIER_PLUGINS: TrustedPlugin[] = [
  {
    name: 'antseed-verifier',
    type: 'verifier',
    description: 'TEE attestation verifier + prover (Intel TDX, DCAP)',
    package: '@antseed/antseed-verifier',
    version: '0.1.0',
  },
]

export const TRUSTED_PLUGINS: TrustedPlugin[] = [
  ...TRUSTED_PROVIDER_PLUGINS,
  ...TRUSTED_ROUTER_PLUGINS,
  ...TRUSTED_VERIFIER_PLUGINS,
]

export function resolvePluginPackage(nameOrPackage: string): string {
  const trusted = TRUSTED_PLUGINS.find((plugin) => plugin.name === nameOrPackage)
  return trusted?.package ?? nameOrPackage
}
