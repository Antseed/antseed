import config from '../../data/colony.json';

/* The sign-up links arrive before launch through src/data/colony.json. Until `formUrl` is an https URL, every sign-up button
   points at the page's own sign-up block; `communityUrl`, once set, adds the community button. */

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

const links = config as {formUrl?: unknown; communityUrl?: unknown};

export const FORM_URL = httpsUrl(links.formUrl);
export const COMMUNITY_URL = httpsUrl(links.communityUrl);
export const SIGN_UP_HREF = FORM_URL ?? '#join';
