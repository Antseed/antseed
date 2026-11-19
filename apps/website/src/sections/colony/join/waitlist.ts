import type {Waitlist} from '../config';

/** One sign-up as the waitlist sheet stores it. */
export type Row = {email: string; name: string; mac: string; chip: string; memory: string; gb: number | ''; source: string; code: string};
/** What the sheet answers: their place in line, and their first invite code when the email was already on the list. */
export type Spot = {spot?: number; code?: string; error?: string};
export type Sink = {send: (row: Row) => Promise<Spot>; step?: (name: string, code: string) => Promise<Spot>};

declare global {
  // a preview can stand in for the sheet: send(row) -> {spot, code}, step(name, code) -> {spot}
  interface Window { colonyWaitlist?: Sink }
}

/**
 * Where a sign-up goes. With `spotUrl` (the script on the waitlist sheet) the sheet saves the row and answers {spot, code}, and each
 * move-up step is counted there; the script sets the order. If the script doesn't answer, or there is no spotUrl, the Google Form's
 * entry fields get a no-cors POST instead, whose answer can't be read, so no place is shown. Null when neither is set.
 */
export function waitlistSink(w: Waitlist | null): Sink | null {
  if (typeof window !== 'undefined' && window.colonyWaitlist) return window.colonyWaitlist;
  if (!w) return null;
  const toForm = w.action && Object.keys(w.fields).length ? async (row: Row): Promise<Spot> => {
    const body = new FormData();
    for (const [key, id] of Object.entries(w.fields)) {
      const value = row[key as keyof Row];
      if (id && value !== '' && value != null) body.append(id, String(value));
    }
    await fetch(w.action!, {method: 'POST', mode: 'no-cors', body});
    return {};
  } : null;
  // text/plain, so the browser sends it without a preflight
  const ask = async (body: unknown): Promise<Spot> => (await fetch(w.spotUrl!, {method: 'POST', body: JSON.stringify(body)})).json();
  if (w.spotUrl) {
    return {
      async send(row) {
        // one retry first: a row that lands through the form has no invite code, so its friends and steps can't be counted
        for (let i = 0; i < 2; i++) {
          try { const r = await ask(row); if (r && !r.error) return r; } catch { /* the script didn't answer */ }
        }
        return toForm ? toForm(row) : {};
      },
      step: (name, code) => ask({code, step: name}).catch(() => ({})),
    };
  }
  return toForm && {send: toForm};
}

const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
/** Their own invite code, for the link that counts friends who join. It starts with a letter, so the sheet never reads it as a number. */
export const newCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b, i) => (i ? LETTERS + '23456789' : LETTERS)[b % (i ? 31 : 23)]).join('');

/** Where they came from, so creator links can be counted: ?ref= first, then utm_source, then the referring site. */
export function sourceOf(search: string, referrer: string): string {
  const params = new URLSearchParams(search);
  return (params.get('ref') || params.get('utm_source') || referrer.replace(/^https?:\/\/([^/]+).*/, '$1') || 'direct').slice(0, 80);
}

/** A place in line from the sheet's answer, when it is one. */
export const spotOf = (r: Spot | undefined): number | null => (Number.isInteger(r?.spot) && r!.spot! > 0 ? r!.spot! : null);
