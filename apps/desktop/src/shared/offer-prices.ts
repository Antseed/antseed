/** A model's per-million token prices; null when no seller reported one. */
export type OfferPrices = { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; cachedInputUsdPerMillion?: number | null };

/** Every token price is $0, cached input included (absent counts as $0, as the buyer reads it). */
export function isFreeOffer(offer: OfferPrices): boolean {
  return offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0 && (offer.cachedInputUsdPerMillion ?? 0) === 0;
}
