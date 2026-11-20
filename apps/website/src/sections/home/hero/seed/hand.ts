/** The seed in the visitor's hand, shared by the cursor and the mascot. Positions are in the hero card's px. */
export type Hand = {
  /** where the pointer is */
  x: number; y: number;
  /** where the seed is drawn, easing after the pointer */
  sx: number; sy: number;
  /** the pointer is over the card */
  on: boolean;
  /** over the pill, the install block or the seed on the ground: the system cursor, the seed under them */
  overUi: boolean;
  /** eaten, and the next seed still on the ground */
  empty: boolean;
};

export const newHand = (): Hand => ({x: 0, y: 0, sx: 0, sy: 0, on: false, overUi: false, empty: false});

/** Seed size, CSS px (the art is 64 × 89). */
export const SEED_W = 64;
export const SEED_H = 89;

/** Marks the elements over which the seed hides and the system cursor shows. */
export const UI_ATTR = 'data-hero-ui';

/** The class names the hand puts on the hero card. */
export type HandClasses = {seeding: string; overUi: string; empty: string; fed: string};
