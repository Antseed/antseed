/**
 * Analytics event helpers.
 *
 * Events are pushed to the GTM dataLayer, and GTM forwards them to GA4 (and any
 * other tag configured later) without further code changes. The dataLayer array
 * is safe to push to before GTM loads — GTM replays anything queued — so these
 * helpers work regardless of load order, and no-op cleanly when GTM is absent
 * (local dev, or before GTM_CONTAINER_ID is set).
 *
 * GA4 is configured as a tag inside the GTM container; nothing else is
 * loaded here.
 */

import {DOWNLOAD_BASE_URL} from './useLatestDesktopDownload';

type DataLayerEvent = Record<string, unknown> & {event: string};

declare global {
  interface Window {
    dataLayer?: DataLayerEvent[];
  }
}

/** Push an event to the dataLayer. No-ops during SSR. */
export function track(event: string, params: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({event, ...params});
}

/**
 * Any link that points at our download proxy (download.antseed.com, see
 * apps/download-proxy), a release asset, or the latest-release fallback
 * counts as an AI VPN download — the proxy URL is the normal per-platform CTA
 * target, and /releases/latest is what `useLatestDesktopDownload` returns
 * when detection fails. The bare /releases list (the "all platforms &
 * versions" escape hatch) is deliberately excluded: browsing versions is not
 * a download conversion, and it tracks as a plain outbound click.
 */
export function isDownloadUrl(href: string): boolean {
  return (
    /^https?:\/\/download\.antseed\.com(\/|$)/i.test(href) ||
    /^https?:\/\/(www\.)?github\.com\/AntSeed\/antseed\/releases\/(latest|download)(\/|$)/i.test(href)
  );
}

/**
 * Which OS a download link is for, read from the proxy path
 * (`/vpr/mac-arm64`) or a release asset filename (`…-arm64.dmg`,
 * `…-x64.exe`, `….AppImage`). Derived from the URL rather than passed down
 * as a prop so no button or call site needs to know about analytics. Returns
 * 'releases_page' for the generic fallback link, where the user picks the
 * asset themselves and we genuinely don't know yet.
 */
export function platformFromUrl(href: string): string {
  const proxy = /\/vpr\/(mac|win|linux)-(?:arm64|x64)(\?|$)/i.exec(href);
  if (proxy) return proxy[1].toLowerCase();
  if (/\.(dmg|pkg)(\?|$)/i.test(href)) return 'mac';
  if (/\.(exe|msi)(\?|$)/i.test(href)) return 'win';
  if (/\.(appimage|deb|rpm|tar\.gz)(\?|$)/i.test(href)) return 'linux';
  return 'releases_page';
}

/**
 * GA client id from the first-party `_ga` cookie ("GA1.1.<A>.<B>" → "<A>.<B>").
 * Null when GA hasn't set cookies (blocked, consent pending, SSR).
 */
export function gaClientId(): string | null {
  if (typeof document === 'undefined') return null;
  const match = /(?:^|; )_ga=([^;]+)/.exec(document.cookie);
  if (!match) return null;
  const parts = decodeURIComponent(match[1]).split('.');
  if (parts.length < 4 || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return null;
  return `${parts[2]}.${parts[3]}`;
}

/**
 * GA session id from the `_ga_<stream>` cookie. Two formats exist in the
 * wild: "GS1.1.<sessionId>.<n>..." (dot-separated) and
 * "GS2.1.s<sessionId>$o<n>$..." (dollar-separated).
 */
export function gaSessionId(): string | null {
  if (typeof document === 'undefined') return null;
  const match = /(?:^|; )_ga_[A-Z0-9]+=([^;]+)/.exec(document.cookie);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  const gs2 = /\.s(\d+)/.exec(value);
  if (gs2) return gs2[1];
  const parts = value.split('.');
  if (parts.length >= 3 && /^\d+$/.test(parts[2])) return parts[2];
  return null;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'] as const;
const UTM_STORAGE_KEY = 'antseed_landing_utm';
const UTM_VALUE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

type LandingUtm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

function utmFromSearch(search: string): LandingUtm {
  const out: LandingUtm = {};
  const params = new URLSearchParams(search);
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value && UTM_VALUE_RE.test(value)) out[key] = value;
  }
  return out;
}

/**
 * Keep the campaign tags a visitor landed with (?utm_source=github&…) for
 * the rest of the tab session, so a download clicked three pages later can
 * still carry them. Called once per page load from the Root theme. Uses
 * sessionStorage: per tab, cleared when the tab closes, never sent anywhere
 * by itself. No-ops during SSR or when storage is unavailable.
 */
export function rememberLandingUtm(): void {
  if (typeof window === 'undefined') return;
  const found = utmFromSearch(window.location.search);
  if (Object.keys(found).length === 0) return;
  try {
    window.sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(found));
  } catch {
    // Storage blocked: the current page's tags still apply via landingUtm().
  }
}

/** Tags from the current URL, else the ones remembered at landing, else none. */
export function landingUtm(): LandingUtm {
  if (typeof window === 'undefined') return {};
  const current = utmFromSearch(window.location.search);
  if (Object.keys(current).length > 0) return current;
  try {
    const raw = window.sessionStorage.getItem(UTM_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: LandingUtm = {};
    for (const key of UTM_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && UTM_VALUE_RE.test(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Append the visitor's GA ids to a download-proxy URL (?cid=...&sid=...), so
 * the proxy's server-side download_started/completed events land inside this
 * visitor's GA session and inherit source/campaign attribution, and carry the
 * landing page's utm_* tags so the proxy can record the source even when GA
 * never ran (ad blockers). Non-proxy URLs and already-attributed URLs pass
 * through unchanged; without GA cookies the tags alone still travel.
 */
export function withGaAttribution(href: string): string {
  try {
    const url = new URL(href);
    if (url.hostname !== new URL(DOWNLOAD_BASE_URL).hostname) return href;
    if (url.searchParams.has('cid')) return href;
    let changed = false;
    const cid = gaClientId();
    if (cid) {
      url.searchParams.set('cid', cid);
      const sid = gaSessionId();
      if (sid) url.searchParams.set('sid', sid);
      changed = true;
    }
    for (const [key, value] of Object.entries(landingUtm())) {
      if (value && !url.searchParams.has(key)) {
        url.searchParams.set(key, value);
        changed = true;
      }
    }
    return changed ? url.toString() : href;
  } catch {
    return href;
  }
}

/**
 * True for internal links into the /get-started mobile onboarding flow
 * (e.g. the mobile-sidebar navbar item). Expects an absolute URL.
 */
export function isGetStartedUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (typeof window !== 'undefined' && url.hostname !== window.location.hostname) return false;
    return /^\/get-started\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** True for links leaving antseed.com. Protocol links (mailto:, tel:) excluded. */
export function isOutboundUrl(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(href).hostname !== window.location.hostname;
  } catch {
    return false;
  }
}

/**
 * Label for where on the page a click happened, so GA4 can tell the hero CTA
 * apart from the one in the footer.
 *
 * Order of preference: an explicit `data-analytics-section`, then the heading
 * of the nearest section/header/footer, then that element's tag name. Ids that
 * Docusaurus generates for its own layout (`__docusaurus_skipToContent_fallback`
 * and friends) are skipped — they are the same on every page and would make
 * every click look like it came from the same place.
 */
export function sectionOf(el: Element | null): string {
  let node: Element | null = el;
  while (node && node !== document.body) {
    const explicit = node.getAttribute?.('data-analytics-section');
    if (explicit) return explicit;

    if (node.id && !node.id.startsWith('__docusaurus')) return node.id;

    if (/^(SECTION|HEADER|FOOTER|ARTICLE|ASIDE)$/.test(node.tagName)) {
      const heading = node.querySelector('h1, h2, h3');
      const text = heading && (heading as HTMLElement).innerText;
      if (text) return text.trim().replace(/\s+/g, ' ').slice(0, 60);
      return node.tagName.toLowerCase();
    }

    node = node.parentElement;
  }
  return 'unknown';
}

/**
 * The label a user actually saw. `textContent` concatenates every child
 * including responsive variants hidden with CSS — the download CTA would report
 * "Download VPRGet Started" because it carries both a desktop and a mobile
 * label. `innerText` respects rendered visibility and returns just the visible
 * one.
 */
export function visibleLabel(el: HTMLElement): string {
  const text = el.innerText || el.textContent || '';
  return text.trim().replace(/\s+/g, ' ').slice(0, 100);
}
