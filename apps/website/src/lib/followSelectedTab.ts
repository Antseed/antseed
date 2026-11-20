/**
 * Keeps a tab bar's marker under its selected tab: writes `<prefix>-x` and `<prefix>-w` (the tab's offset and width) on `bar`, and
 * again whenever the bar resizes. `place()` measures once more (after the fonts load); `stop()` ends the tracking.
 */
export function followSelectedTab(bar: HTMLElement, selected: number, prefix: string): {place(): void; stop(): void} {
  const place = () => {
    const tab = bar.querySelectorAll<HTMLElement>('[role="tab"]')[selected];
    if (!tab) return;
    bar.style.setProperty(`${prefix}-x`, `${tab.offsetLeft}px`);
    bar.style.setProperty(`${prefix}-w`, `${tab.offsetWidth}px`);
  };
  place();
  const ro = new ResizeObserver(place);
  ro.observe(bar);
  return {place, stop: () => ro.disconnect()};
}
