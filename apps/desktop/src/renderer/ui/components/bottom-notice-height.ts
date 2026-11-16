/**
 * The space the window's bottom bars need. More than one can show at once (an
 * update and a deposit), each fixed at the bottom edge, so the layout ends
 * above the tallest; it goes back to the edge only once the last one is gone.
 */
export function createBarHeights(write: (heightPx: number | null) => void) {
  const heights = new Map<object, number>();
  const publish = () => write(heights.size > 0 ? Math.max(...heights.values()) : null);
  return {
    set(bar: object, heightPx: number): void {
      heights.set(bar, heightPx);
      publish();
    },
    remove(bar: object): void {
      heights.delete(bar);
      publish();
    },
  };
}
