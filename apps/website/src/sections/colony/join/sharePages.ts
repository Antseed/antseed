// Imported by plugins/colony-share-pages.ts and cardFacts.test.ts under plain Node, so this file imports only macs.ts.
import {MACS} from './macs.ts';

const SITE = 'https://antseed.com';
const TITLE = 'Join the first Mac Colony | Antseed';
const DESCRIPTION = 'Colony joins Macs into one AI provider on Antseed. Join the waitlist for the first Mac Colony. Any Apple silicon Mac can sign up.';

/** "MacBook Pro" -> "macbook-pro": the Mac's share page (/colony/mac/<slug>/) and its card picture (share/<slug>.jpg). */
export const macSlug = (model: string): string => model.toLowerCase().replace(/\s+/g, '-');

/**
 * The page a shared Colony post links to, one per Mac the sign-up offers: link previews show that Mac's card, and people go on to
 * /colony/. Written into the build by plugins/colony-share-pages.ts.
 */
export function sharePage(model: string): {path: string; image: string; html: string} {
  const slug = macSlug(model);
  const path = `/colony/mac/${slug}/`;
  const image = `/site/assets/colony/share/${slug}.jpg`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Antseed">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:image" content="${SITE}${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="My ${model} wants in. Mac Colony waitlist on Antseed">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@antseed">
<meta name="twitter:image" content="${SITE}${image}">
<script>location.replace('/colony/')</script>
</head>
<body><p><a href="/colony/">Join the first Mac Colony</a></p></body>
</html>
`;
  return {path, image, html};
}

/** Every Mac's share page. */
export const sharePages = () => Object.keys(MACS).map(sharePage);
