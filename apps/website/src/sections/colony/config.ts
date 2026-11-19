import config from '../../data/colony.json';

/* What the Colony page and its waitlist read before and after launch, from src/data/colony.json:
     telegramUrl  Local AI Colony, the local AI Telegram group; its link shows the "Join the community" buttons and the "while you wait" step
     downloadUrl  the Colony app once it is public; shows "Download for Mac" under "Invited? Set up your Mac"
     waitlist     where /colony/join/ sends a sign-up: formUrl is the Google Form (it collects the verified Google-account email and
                  allows one response per account), and fields maps each answer to that form's prefilled entry id */

export type WaitlistField = 'name' | 'mac' | 'chip' | 'memory' | 'source';
export type Waitlist = {formUrl: string | null; fields: Partial<Record<WaitlistField, string>>};

export const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

const raw = config as {telegramUrl?: unknown; downloadUrl?: unknown; waitlist?: {formUrl?: unknown; fields?: unknown} | null};

export const TELEGRAM_URL = httpsUrl(raw.telegramUrl);
export const DOWNLOAD_URL = httpsUrl(raw.downloadUrl);

const fields = (raw.waitlist?.fields && typeof raw.waitlist.fields === 'object' ? raw.waitlist.fields : {}) as Record<string, unknown>;
export const WAITLIST: Waitlist | null = raw.waitlist
  ? {
      formUrl: httpsUrl(raw.waitlist.formUrl),
      fields: Object.fromEntries(Object.entries(fields).filter(([, id]) => typeof id === 'string' && /^entry\.\d+$/.test(id))) as Waitlist['fields'],
    }
  : null;

/** Every sign-up happens on the step-by-step page. */
export const JOIN_HREF = '/colony/join/';
