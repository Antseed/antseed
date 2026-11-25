import type { CreditsInfo } from './credits.js';

/**
 * The last balance read for the current identity, gateway and key. A failed
 * read serves it rather than a zero; changing the identity forgets it, and a
 * read for another gateway or key (or none) never sees it, so neither a
 * restart nor a gateway switch shows another wallet's balance.
 */
export class LastCredits {
  private last: CreditsInfo | null = null;
  private scope: string | null = null;

  /**
   * The answer to show for `credits`, read for `scope` (null when no gateway
   * answered): itself, or the last known one for that same scope if this read failed.
   */
  settle(credits: CreditsInfo, scope: string | null): CreditsInfo {
    if (scope === null || scope !== this.scope) {
      this.last = null;
      this.scope = scope;
    }
    if (!credits.balanceKnown && this.last?.balanceKnown) return this.last;
    this.last = credits;
    return credits;
  }

  /** Whether the last read found nothing the buyer owns; undefined until one is known. */
  isZero(): boolean | undefined {
    if (!this.last?.balanceKnown) return undefined;
    return Number(this.last.totalOwnedUsdc) <= 0;
  }

  clear(): void {
    this.last = null;
    this.scope = null;
  }
}
