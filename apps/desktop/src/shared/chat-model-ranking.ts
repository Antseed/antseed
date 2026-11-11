type RankedModel = { free: boolean; toolUse: boolean; sellers: number; lowTrust?: boolean };

/** Best default first: served by a trusted seller, then free for everyone, then able to use tools, then the most sellers. */
export function compareDefaultModels(left: RankedModel, right: RankedModel): number {
  return Number(left.lowTrust === true) - Number(right.lowTrust === true)
    || Number(right.free) - Number(left.free)
    || Number(right.toolUse) - Number(left.toolUse)
    || right.sellers - left.sellers;
}
