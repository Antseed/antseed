/**
 * Moves the page to its top when the flow changes screen. It returns nothing on purpose: current Chrome returns a Promise from
 * `scrollTo`, and React would call an effect's return value as its cleanup.
 */
export function scrollToTop(): void {
  window.scrollTo(0, 0);
}
