import { parsePinnedModel } from '@antseed/node/model-identity';

/**
 * A chat can pin one seller for its model with `<peerId>@<model>`, the form
 * the gateway accepts (and checks against the key's routing policy). The
 * conversation stores that string; the picker and lookups use its parts.
 */
export function splitPinnedModel(value: string | null | undefined): { modelId: string; peerId: string | null } {
  const text = value ?? '';
  return parsePinnedModel(text) ?? { modelId: text, peerId: null };
}

/** A seller id as pins carry it: lowercase, without `0x`. Compare ids in this form. */
export function normalizeSellerId(id: string): string {
  return id.toLowerCase().replace(/^0x/, '');
}

/** `<peerId>@<model>`, or the model alone when no seller is pinned. */
export function joinPinnedModel(modelId: string, peerId: string | null | undefined): string {
  const { modelId: bare } = splitPinnedModel(modelId);
  return peerId ? `${normalizeSellerId(peerId)}@${bare}` : bare;
}

/** How a request on `modelId` reaches a seller: the one it names, or whichever the gateway picks. */
export function routeModeOf(modelId: string): 'pinned' | 'auto' {
  return splitPinnedModel(modelId).peerId ? 'pinned' : 'auto';
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

/**
 * Whether an image model can edit an image. Unpinned, one seller that takes
 * image input is enough: the gateway sends edits only to sellers that do.
 */
export function imageModelCanEdit(
  model: { supportsImages: boolean; imageInputSellerIds?: string[] },
  modelId: string,
): boolean {
  if (splitPinnedModel(modelId).peerId) return modelAcceptsImages(model, modelId);
  return model.supportsImages || (model.imageInputSellerIds?.length ?? 0) > 0;
}
