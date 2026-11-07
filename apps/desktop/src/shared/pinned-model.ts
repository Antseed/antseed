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

/** Whether a chat on `modelId` can send images: any seller the gateway may pick takes them, or the pinned one does. */
export function modelAcceptsImages(
  model: { supportsImages: boolean; imageInputSellerIds?: string[] },
  modelId: string,
): boolean {
  if (model.supportsImages) return true;
  const { peerId } = splitPinnedModel(modelId);
  return Boolean(peerId && model.imageInputSellerIds?.includes(peerId));
}
