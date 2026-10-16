/**
 * The model the model detail page is currently showing.
 *
 * Browsing a model must not change the route selection — only the page's
 * "Use" button applies it. The explore list records the tapped model here and
 * then navigates; the model view reads it on mount (ViewHost remounts views on
 * navigation, so no reactivity is needed). Falls back to the applied selection
 * when nothing was recorded (e.g. after an app reload).
 */

export type VprModelPageTarget = { provider: string; serviceId: string };

let target: VprModelPageTarget | null = null;

export function setVprModelPageTarget(provider: string, serviceId: string): void {
  target = { provider, serviceId };
}

export function vprModelPageTarget(): VprModelPageTarget | null {
  return target;
}
