/** Plays a one-shot CSS animation class again: added now, removed when its animation ends so the next call can replay it. The
 *  class lives on the DOM node, so the element's React className must not change meanwhile. */
export function replayAnimation(el: Element | null, className: string): void {
  if (!el || el.classList.contains(className)) return;
  el.classList.add(className);
  el.addEventListener('animationend', () => el.classList.remove(className), {once: true});
}
