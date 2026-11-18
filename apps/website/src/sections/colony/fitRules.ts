export const MACS = ['Mac Studio', 'MacBook Pro', 'Mac mini', 'iMac', 'MacBook Air', 'Other'] as const;
export const MEMORY = ['8 GB', '16 GB', '18 GB', '24 GB', '32 GB', '36 GB', '48 GB', '64 GB', '96 GB', '128 GB', '192 GB', '256 GB', '512 GB', 'Not sure'] as const;

/** The first Colony serves a large model: Mac Studios with this much memory go first. */
const FIRST_MIN_GB = 256;
const IDEAL_GB = 512;

export type Fit = {tier: 'none' | 'first' | 'later'; message: string};

/** Where a Mac fits, from the two choices alone; nothing is sent anywhere. */
export function macFit(mac: string, memory: string): Fit {
  if (!mac || !memory) return {tier: 'none', message: 'Pick your Mac and its memory.'};
  const gb = parseInt(memory, 10);
  if (mac === 'Mac Studio' && gb >= IDEAL_GB) return {tier: 'first', message: 'The first Colony. 512 GB is ideal.'};
  if (mac === 'Mac Studio' && gb >= FIRST_MIN_GB) return {tier: 'first', message: 'The first Colony. Mac Studios with 256 GB or more go first.'};
  if (memory === 'Not sure') return {tier: 'none', message: 'You’ll find it under About This Mac. Sign up either way.'};
  return {tier: 'later', message: 'Later Colonies. Sign up and you stay on the list.'};
}
