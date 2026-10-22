// Link previews for profile pages. The site is a client-rendered SPA, so X and
// other crawlers only see index.html; /u/:handle swaps its generic title and
// Open Graph / Twitter tags for ones that name the profile and point at the
// server-rendered share card.
import { epochAt } from '../../src/lib/points';
import type { XRecord } from './store';

export interface PageMeta {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function profileMeta(rec: Pick<XRecord, 'handle' | 'name'>, origin: string, now = Date.now()): PageMeta {
  const handle = encodeURIComponent(rec.handle);
  const who = rec.name && rec.name !== rec.handle ? `${rec.name} (@${rec.handle})` : `@${rec.handle}`;
  return {
    title: `${who} on Antseed Points`,
    description: `@${rec.handle}'s points this week on Antseed, with their estimated ANTS this week and their rank among buyers. The AI network that rewards you for using it.`,
    url: `${origin}/u/${handle}`,
    // The epoch in the URL makes X fetch a fresh card each week instead of reusing last week's.
    image: `${origin}/api/card/${handle}.png?e=${epochAt(now)}`,
    imageAlt: `Antseed Points card for @${rec.handle}: points this week, estimated ANTS this week and rank among buyers.`,
  };
}

/** Replaces the page's <title>, description, og:* and twitter:* tags with the given ones. */
export function injectMeta(html: string, m: PageMeta): string {
  const tags = [
    `<title>${esc(m.title)}</title>`,
    `<meta name="description" content="${esc(m.description)}" />`,
    `<link rel="canonical" href="${esc(m.url)}" />`,
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:site_name" content="Antseed Points" />`,
    `<meta property="og:url" content="${esc(m.url)}" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(m.description)}" />`,
    `<meta property="og:image" content="${esc(m.image)}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(m.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(m.title)}" />`,
    `<meta name="twitter:description" content="${esc(m.description)}" />`,
    `<meta name="twitter:image" content="${esc(m.image)}" />`,
    `<meta name="twitter:image:alt" content="${esc(m.imageAlt)}" />`,
  ];
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s[^>]*?(?:name|property)="(?:description|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi, '')
    .replace(/<link\s[^>]*?rel="canonical"[^>]*>\s*/gi, '');
  return stripped.replace(/\s*<\/head>/i, `\n    ${tags.join('\n    ')}\n  </head>`);
}
