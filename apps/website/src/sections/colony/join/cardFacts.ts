import {MACS, NO_MAC, type Answers} from './macs.ts';

/** What a waitlist card names: the first name and the Mac line. */
export type CardFacts = {name: string; mac: string};

export const SHARE_URL = 'https://antseed.com/colony/';
const KEY = 'antseed-colony-card';

/** "MacBook Pro · M3 Max · 36 GB"; nothing for someone without a Mac. */
export const macLine = (a: Pick<Answers, 'mac' | 'chip' | 'memory'>): string =>
  a.mac === NO_MAC ? '' : [a.mac, a.chip, a.memory].filter(Boolean).join(' · ');

/** The words that go with the card on X: their Mac by name (the first part of the Mac line), and a question for their followers. */
export const shareText = (mac: string): string => {
  const model = mac.split(' · ')[0];
  return model
    ? `Just put my ${model} on the waitlist for the first Mac Colony on @AntSeed. It joins Macs into one AI provider. Who else is bringing a Mac?`
    : 'Just joined the waitlist for the first Mac Colony on @AntSeed. It joins Macs into one AI provider. Who’s bringing a Mac?';
};

const cleanName = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
// a Mac line is kept only when it starts with a Mac the sign-up offers, so nothing else can put words on the card
const cleanMac = (v: string | null | undefined) => { const s = (v ?? '').trim().slice(0, 80); return Object.keys(MACS).some((m) => s === m || s.startsWith(`${m} · `)) ? s : ''; };

/** The card in what this browser kept, cleaned the same way whoever wrote it. */
export function readCard(stored: string | null): CardFacts {
  try {
    const v = JSON.parse(stored ?? '{}') as {name?: unknown; mac?: unknown};
    return {name: cleanName(typeof v.name === 'string' ? v.name : ''), mac: cleanMac(typeof v.mac === 'string' ? v.mac : '')};
  } catch {
    return {name: '', mac: ''};
  }
}

/** Kept in this browser when the form opens, so the page Google's thank-you note links to can show the same card. */
export function rememberCard(facts: CardFacts): void {
  try { localStorage.setItem(KEY, JSON.stringify({name: cleanName(facts.name), mac: facts.mac})); } catch { /* private mode: the card just has no name */ }
}

export function recallCard(): CardFacts {
  try { return readCard(localStorage.getItem(KEY)); } catch { return {name: '', mac: ''}; }
}
