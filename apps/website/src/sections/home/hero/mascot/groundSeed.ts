/** What decides that the seed drops onto the ground by the mascot. */
export type GroundSeedState = {
  /** The screen's main pointer can't hover (a phone or a tablet). */
  touchFirst: boolean;
  /** A finger has pressed on the card, on any screen (a touch laptop, a tablet whose main pointer hovers). */
  fingerSeen: boolean;
  /** The seed has already dropped once. */
  seeded: boolean;
  /** Reduced motion: the mascot stays still and nothing is fed. */
  still: boolean;
  /** How far the mascot has faded in, 0 to 1. */
  shown: number;
  /** The painting's arrival still covers the card. */
  covered: boolean;
};

/** A finger has no seed in hand, so for one the seed drops in by the mascot, once, as it fades in and once the painting's cover is gone. */
export function dropsGroundSeed({touchFirst, fingerSeen, seeded, still, shown, covered}: GroundSeedState): boolean {
  return (touchFirst || fingerSeen) && !seeded && !still && shown > 0.9 && !covered;
}
