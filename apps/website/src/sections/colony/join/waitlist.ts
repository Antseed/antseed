import type {Waitlist} from '../config';
import type {Answers} from './macs';

/**
 * The prefilled Google Form URL for a sign-up. The form is the whole sign-up: it collects the verified Google-account email and allows
 * one response per account, so a visitor's answers are carried in as prefilled fields and Google handles the email, the dedup and the
 * sign-in. Null when no form is configured (before launch).
 */
export function prefillUrl(w: Waitlist | null, answers: Answers, source: string): string | null {
  if (!w?.formUrl) return null;
  const url = new URL(w.formUrl);
  url.searchParams.set('usp', 'pp_url');
  const values: Partial<Record<keyof Waitlist['fields'], string>> = {
    name: answers.name, mac: answers.mac, chip: answers.chip, memory: answers.memory, source,
  };
  for (const [key, id] of Object.entries(w.fields)) {
    const value = values[key as keyof typeof values];
    if (id && value) url.searchParams.set(id, value);
  }
  return url.href;
}

/** Where they came from, so creator links can be told apart: ?ref= first, then utm_source, then the referring site. */
export function sourceOf(search: string, referrer: string): string {
  const params = new URLSearchParams(search);
  return (params.get('ref') || params.get('utm_source') || referrer.replace(/^https?:\/\/([^/]+).*/, '$1') || 'direct').slice(0, 80);
}
