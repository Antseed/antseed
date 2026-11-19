import config from '../../data/colony.json';

/* What the Colony page and its waitlist read before and after launch, from src/data/colony.json:
     telegramUrl  the Anthill, the local AI Telegram group; its link shows the "Join the Anthill" buttons and the move-up step
     downloadUrl  the Colony app once it is public; shows "Download for Mac" under "Invited? Set up your Mac"
     waitlist     where /colony/join/ sends a sign-up: spotUrl (the script on the waitlist sheet, which answers with the place in line)
                  and, as the backup, the Google Form's formResponse address with the entry id of each field */

export type WaitlistField = 'email' | 'name' | 'mac' | 'chip' | 'memory' | 'source';
export type Waitlist = {spotUrl: string | null; action: string | null; fields: Partial<Record<WaitlistField, string>>};

export const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

const raw = config as {telegramUrl?: unknown; downloadUrl?: unknown; waitlist?: {spotUrl?: unknown; action?: unknown; fields?: unknown} | null};

export const TELEGRAM_URL = httpsUrl(raw.telegramUrl);
export const DOWNLOAD_URL = httpsUrl(raw.downloadUrl);

const fields = (raw.waitlist?.fields && typeof raw.waitlist.fields === 'object' ? raw.waitlist.fields : {}) as Record<string, unknown>;
export const WAITLIST: Waitlist | null = raw.waitlist
  ? {
      spotUrl: httpsUrl(raw.waitlist.spotUrl),
      action: httpsUrl(raw.waitlist.action),
      fields: Object.fromEntries(Object.entries(fields).filter(([, id]) => typeof id === 'string' && /^entry\.\d+$/.test(id))) as Waitlist['fields'],
    }
  : null;

/** Every sign-up happens on the step-by-step page. */
export const JOIN_HREF = '/colony/join/';
