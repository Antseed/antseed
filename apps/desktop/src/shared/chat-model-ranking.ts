type RankedModel = { free: boolean; toolUse: boolean; sellers: number; lowTrust?: boolean };

/**
 * Best default first: one that works without funds, so free for everyone
 * (trusted, then low-trust), then paid (trusted, then low-trust); then able to
 * use tools, then the most sellers.
 */
export function compareDefaultModels(left: RankedModel, right: RankedModel): number {
  return Number(right.free) - Number(left.free)
    || Number(left.lowTrust === true) - Number(right.lowTrust === true)
    || Number(right.toolUse) - Number(left.toolUse)
    || right.sellers - left.sellers;
}

type ListedModel = { type: string | null; free: boolean; lowTrust?: boolean };

/**
 * The models the connected apps and the chat picker list: those a trusted
 * seller serves, plus, while no trusted seller serves a free text model, the
 * free text models low-trust sellers serve, so a user without funds still has
 * one that answers.
 */
export function listedModels<T extends ListedModel>(models: T[]): T[] {
  const isText = (model: T) => model.type === null || model.type === 'text';
  const trustedFreeText = models.some((model) => isText(model) && model.free && !model.lowTrust);
  return models.filter((model) => !model.lowTrust || (!trustedFreeText && isText(model) && model.free));
}
