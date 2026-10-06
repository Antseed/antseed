/**
 * @antseed/model-verifier — audit any OpenAI- or Anthropic-compatible endpoint against a
 * published KBF model reference. Transport-agnostic: Antseed peers, other networks and
 * direct providers are all just a `ModelEndpoint`.
 */

export * from './endpoint.js'
export * from './completion.js'
export * from './audit.js'
export * from './reference.js'
export * from './score.js'
export { OpenAIChatEndpoint, type OpenAIChatEndpointOptions } from './endpoints/openai-chat.js'
export { AnthropicMessagesEndpoint, type AnthropicMessagesEndpointOptions } from './endpoints/anthropic-messages.js'
