import type { CreditsInfo } from './credits.js';

/**
 * The last balance read for the current identity. A failed read serves it
 * rather than a zero; changing the identity forgets it, so a read that fails
 * while the gateway restarts never shows the previous signer's balance.
 */
export class LastCredits {
  private last: CreditsInfo | null = null;

  /** The answer to show for `credits`: itself, or the last known one if this read failed. */
  settle(credits: CreditsInfo): CreditsInfo {
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
  }
}
