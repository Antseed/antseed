/**
 * Lines the walking ant shows while a reply is on its way. One is picked at
 * random per turn and re-rolled every few seconds. Keep them short, kind and
 * work-safe; the ant adds the trailing ellipsis.
 */
export const THINKING_PHRASES: readonly string[] = [
  // The originals.
  'Hodl',
  'Brrrr',
  'NGMI',
  'WAGMI',
  'To the moon',
  'Wen channel',
  'gm',
  'Stacking sats',
  'Few understand',
  'LFG',
  'Probably nothing',
  'Aping in',
  'This is the way',
  'Ser, pls wait',
  'Number go up',
  'Diamond hands',
  'p2p2pinging',
  'Foraging for tokens',
  'Pinning to the DHT',
  'Sharding the prompt',
  // More in the old voice.
  'Wen answer',
  'Purr',
  'Ant doing ant things',
  'Probably something',
  'Smol ant, big model',
  'Big ant energy',
  'Wise ant says wait',
  'Ant locked in',
  'Grinding',
  'Tiny ant, huge brain',
  'Ant never sleeps',
  'Gang gang',
];

export function pickThinkingPhrase(exclude?: string, random: () => number = Math.random): string {
  const pick = () => THINKING_PHRASES[Math.floor(random() * THINKING_PHRASES.length)];
  for (let i = 0; i < 6; i += 1) {
    const phrase = pick();
    if (phrase !== exclude) return phrase;
  }
  return pick();
}
