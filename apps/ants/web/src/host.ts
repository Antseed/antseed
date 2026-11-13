import { PAGES, type Page } from './pages';

/**
 * Where the dashboard runs. Standalone (`antseed ants`, the desktop app), it is
 * the whole page: hash routes, `/api` on the local server and a session token.
 * Embedded (the gateway console), the host page owns the URL, the API base,
 * authentication, the wallet connection and the frame around the pages.
 */
export interface AntsHost {
  /** Rendered inside another app: no sidebar, no wallet provider of its own, host-scoped styles. */
  embedded: boolean;
  /** The URL fetched for a dashboard API path such as `/api/positions`. */
  apiUrl(path: string): string;
  /** Headers added to every API request. */
  headers(): Record<string, string>;
  /** Link target for a dashboard path such as `positions` or `stake/12`. */
  href(path: string): string;
  /** The dashboard path currently shown, with its query: `positions?id=3`. */
  currentPath(): string;
  /** Point the browser at a dashboard path without adding history. */
  replace(path: string): void;
  /** Called whenever `currentPath()` may have changed. */
  subscribe(listener: () => void): () => void;
  /** Where dialogs and tooltips mount, so they keep the host's scoped styles. */
  portalTarget(): HTMLElement;
  /** The pages this host shows; a path to any other page opens the first. */
  pages: readonly Page[];
  /** False when the host shows the buyer account's rewards itself. */
  buyerRewards: boolean;
}

export const TOKEN_KEY = 'ants.dashboard.token';

function storedToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const standalone: AntsHost = {
  embedded: false,
  apiUrl: (path) => path,
  headers: () => ({ Authorization: `Bearer ${storedToken() ?? ''}` }),
  href: (path) => `#/${path}`,
  currentPath: () => window.location.hash.replace(/^#\/?/, ''),
  replace: (path) => window.history.replaceState(null, '', `#/${path}`),
  subscribe: (listener) => {
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  },
  portalTarget: () => document.body,
  pages: PAGES,
  buyerRewards: true,
};

let current: AntsHost = standalone;

export function host(): AntsHost {
  return current;
}

/** Install the embedding host before the dashboard first renders. */
export function setHost(next: AntsHost): void {
  current = next;
}
