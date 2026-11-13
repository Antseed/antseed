/** Canonical identity + display naming for advertised model services.
 *
 * Sellers advertise the same model under near-identical keys ("gpt-5.6-luna",
 * "GPT 5.6 Luna", "openai/gpt-5.6-luna", "gpt-5.6-luna-20260115") and under
 * different provider strings. The canonical key aggressively normalizes a
 * serviceId so those variants aggregate into one catalog entry, and the
 * display label renders a human model name ("Claude Fable 5") so raw service
 * keys never reach the UI.
 */

export { canonicalModelKey, sameCanonicalModel } from '@antseed/node/model-identity';
import { preferredModelDisplayName } from '@antseed/node/model-identity';
/** Human model name for display: a seller-provided label that already reads
 *  as prose wins; slug-shaped labels and raw serviceIds get prettified
 *  ("claude-fable-5" → "Claude Fable 5"). */
export function displayModelLabel(serviceId: string, serviceLabel?: string | null): string {
  return preferredModelDisplayName(serviceId, serviceLabel);
}
