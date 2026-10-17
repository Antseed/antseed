/**
 * Where a download link was clicked, reduced to a public host name.
 *
 * GA4 only learns a visitor's source when its script runs in the browser;
 * for the developer audience that script is often blocked, and those
 * downloads reach GA4 with no session at all. The proxy sees the `Referer`
 * header on the download request regardless, so it can still say which
 * public site the link was on.
 *
 * Privacy: only the host is used (browsers already strip cross-site
 * referrers to their origin by default), and only hosts on a short public
 * allowlist are recorded by name. Anything else — a company wiki, a private
 * Slack workspace, an intranet — is reported as "other", so a referrer can
 * never identify an employer or a private community. No path, query string,
 * or fragment is ever read.
 */

const PUBLIC_HOSTS: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)antseed\.com$/i, 'antseed.com'],
  [/(^|\.)antscan\.co$/i, 'antscan.co'],
  [/(^|\.)github\.com$/i, 'github.com'],
  [/(^|\.)npmjs\.com$/i, 'npmjs.com'],
  [/(^|\.)(x\.com|twitter\.com|t\.co)$/i, 'x.com'],
  [/(^|\.)reddit\.com$/i, 'reddit.com'],
  [/(^|\.)news\.ycombinator\.com$/i, 'news.ycombinator.com'],
  [/(^|\.)(discord\.com|discordapp\.com|discord\.gg)$/i, 'discord.com'],
  [/(^|\.)(t\.me|telegram\.org|telegram\.me)$/i, 'telegram.org'],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$/i, 'chatgpt.com'],
  [/(^|\.)claude\.ai$/i, 'claude.ai'],
  [/(^|\.)perplexity\.ai$/i, 'perplexity.ai'],
  [/(^|\.)gemini\.google\.com$/i, 'gemini.google.com'],
  [/(^|\.)copilot\.microsoft\.com$/i, 'copilot.microsoft.com'],
  [/(^|\.)google\.[a-z.]+$/i, 'google.com'],
  [/(^|\.)bing\.com$/i, 'bing.com'],
  [/(^|\.)duckduckgo\.com$/i, 'duckduckgo.com'],
  [/(^|\.)(yandex\.[a-z]+|ya\.ru)$/i, 'yandex.ru'],
  [/(^|\.)baidu\.com$/i, 'baidu.com'],
  [/(^|\.)youtube\.com$/i, 'youtube.com'],
  [/(^|\.)producthunt\.com$/i, 'producthunt.com'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/i, 'linkedin.com'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com)$/i, 'facebook.com'],
  [/(^|\.)(medium\.com|dev\.to|hashnode\.dev|substack\.com)$/i, 'blog'],
  [/(^|\.)(stackoverflow\.com|stackexchange\.com)$/i, 'stackoverflow.com'],
  [/(^|\.)(huggingface\.co)$/i, 'huggingface.co'],
];

/** `none` when absent or unparseable, an allowlisted public host, else `other`. */
export function referrerHost(header: string | null | undefined): string {
  if (!header) return 'none';
  let host: string;
  try {
    host = new URL(header).hostname.toLowerCase();
  } catch {
    return 'none';
  }
  if (!host) return 'none';
  for (const [pattern, label] of PUBLIC_HOSTS) {
    if (pattern.test(host)) return label;
  }
  return 'other';
}

const UTM_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Sent to GA4 as link_source / link_medium / link_campaign rather than the
 * utm_* names, so they never collide with GA4's own session campaign fields
 * (which only exist when GA ran in the browser).
 */
export interface UtmParams {
  link_source?: string;
  link_medium?: string;
  link_campaign?: string;
}

const UTM_TO_PARAM = {utm_source: 'link_source', utm_medium: 'link_medium', utm_campaign: 'link_campaign'} as const;

/**
 * Campaign tags the website's click handler carries onto the download link
 * (see apps/website/src/lib/analytics.ts). Recorded server-side so a tagged
 * link still attributes when the visitor's browser blocked GA. Strictly
 * shaped: these arrive on a public URL.
 */
export function parseUtm(params: URLSearchParams): UtmParams {
  const out: UtmParams = {};
  for (const [query, param] of Object.entries(UTM_TO_PARAM) as Array<[keyof typeof UTM_TO_PARAM, keyof UtmParams]>) {
    const value = params.get(query);
    if (value && UTM_RE.test(value)) out[param] = value.toLowerCase();
  }
  return out;
}
