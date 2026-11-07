/** Best default first: free for everyone, then able to use tools, then the most sellers. */
export function compareDefaultModels(
  left: { free: boolean; toolUse: boolean; sellers: number },
  right: { free: boolean; toolUse: boolean; sellers: number },
): number {
  return Number(right.free) - Number(left.free)
    || Number(right.toolUse) - Number(left.toolUse)
    || right.sellers - left.sellers;
}
