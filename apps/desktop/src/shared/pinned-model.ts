/**
 * A chat can pin one seller for its model with `<peerId>@<model>`, the form
 * the gateway accepts (and checks against the key's routing policy). The
 * conversation stores that string; the picker and lookups use its parts.
 */
const PINNED_MODEL_RE = /^(?:0x)?([0-9a-fA-F]{40})@(.+)$/;

export function splitPinnedModel(value: string | null | undefined): { modelId: string; peerId: string | null } {
  const text = value ?? '';
  const match = PINNED_MODEL_RE.exec(text);
  return match ? { modelId: match[2]!, peerId: match[1]!.toLowerCase() } : { modelId: text, peerId: null };
}

/** `<peerId>@<model>`, or the model alone when no seller is pinned. */
export function joinPinnedModel(modelId: string, peerId: string | null | undefined): string {
  const { modelId: bare } = splitPinnedModel(modelId);
  return peerId ? `${peerId.toLowerCase().replace(/^0x/, '')}@${bare}` : bare;
}
