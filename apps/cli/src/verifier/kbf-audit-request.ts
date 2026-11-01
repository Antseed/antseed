import {
  KBF_OPTIONAL_SAMPLING_FIELDS,
  buildKbfChatRequestBody,
  type KbfProbe,
} from '@antseed/fingerprints'

/**
 * The chat body an audit sends a seller, for local audits and round collection alike: the
 * canonical KBF body plus the reference's thinking suppression (as the KBF reference code does
 * for every endpoint), at the audit temperature and never streamed. Other reference-endpoint
 * settings (omitted fields, provider pins) never reach sellers.
 */
export function buildKbfAuditChatBody(
  service: string,
  probes: readonly KbfProbe[],
  settings: {
    maxTokens: number
    promptVariantId: string
    temperature: number
    /** The reference's thinking suppression: request fields, and an assistant prefill. */
    thinking: { overrides?: Record<string, unknown>; assistantPrefill?: string | null } | null
    /** Leaves out the optional sampling fields, for upstreams that reject them. */
    omitSampling: boolean
  },
): Record<string, unknown> {
  const chat = buildKbfChatRequestBody(service, probes, { maxTokens: settings.maxTokens, variantId: settings.promptVariantId })
  const body: Record<string, unknown> = {
    ...chat,
    ...(settings.thinking?.assistantPrefill
      ? { messages: [...chat.messages, { role: 'assistant', content: settings.thinking.assistantPrefill }] }
      : {}),
    ...settings.thinking?.overrides,
    // No top_p: the KBF reference code sends only model, messages, temperature and
    // max_tokens, and several upstreams reject top_p (Kimi K3, Opus 5, Opus 4.6).
    temperature: settings.temperature,
    stream: false,
  }
  if (settings.omitSampling) for (const field of KBF_OPTIONAL_SAMPLING_FIELDS) delete body[field]
  return body
}
