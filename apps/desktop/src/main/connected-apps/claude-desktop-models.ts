import { resolveBuyerProxyPort } from '../runtime/active-config.js';

/** A curated picker row offered to Claude Desktop: display label + the model the buyer routes. */
export type ClaudeDesktopModel = { label: string; model: string };

/**
 * The buyer proxy serves Claude Desktop's model list on its `/claude-desktop`
 * route. Without a push it offers the top of its own ranking; the desktop
 * pushes its curated picker rows (favorites, then recommended) so Claude
 * offers the same models as the in-app dropdown.
 */
let latestModels: ClaudeDesktopModel[] = [];

/** Remember the latest picker rows and send them to the running buyer. */
export function setClaudeDesktopModels(models: ClaudeDesktopModel[]): void {
  latestModels = models;
  void pushClaudeDesktopModels();
}

/** Best effort: the buyer persists the list, and the next picker sync or connect resends it. */
export async function pushClaudeDesktopModels(buyerPort?: number): Promise<void> {
  if (latestModels.length === 0) return;
  try {
    const port = buyerPort ?? await resolveBuyerProxyPort();
    await fetch(`http://127.0.0.1:${port}/_antseed/claude-desktop/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: latestModels }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // Buyer not running yet; resent on the next sync or connect.
  }
}
