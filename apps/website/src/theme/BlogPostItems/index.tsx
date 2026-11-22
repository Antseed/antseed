/**
 * BlogPostItems: the card grid of the blog index and tag pages (cover, meta line, title, description), revealed on scroll three at a
 * time; the first row, on the first screen, fades in from the first paint and the featured cover is fetched first. Individual post
 * pages are untouched.
 */
import type {CSSProperties, ReactNode} from 'react';
import Link from '@docusaurus/Link';
import type {Props} from '@theme/BlogPostItems';
import styles from './styles.module.css';

/* Posts pinned to the top use a far-future date (the 2099 hack) — showing
   that date would look broken, so those cards get a "Featured" label. */
const PINNED_YEAR = 2090;

/** Cards in a row: the reveal staggers across one row. */
const COLUMNS = 3;

/* Cards use the generated per-post covers in /img/blog/covers (one SVG per
   slug, drawn in the site palette). A slug listed here keeps its card cover
   even when the post has its own share image, since wide share images with
   headline text crop badly in the card; other posts fall back to their
   frontmatter image. Posts without one share the site-wide og:image. */

const COVER_SLUGS = new Set([
  'buyer-protection',
  'announcing-antseed-non-profit-foundation',
  'seller-pools-reputation-tokenomics',
  'model-verification-fingerprint-swarm',
  'the-permissionless-openrouter-alternative',
  'proof-of-prior-delivery',
  'separation-of-risk',
  'the-402-flow',
  'use-claude-deepseek-llama-privately',
  'ai-infrastructure-bittorrent-not-spotify',
  'the-infrastructure-layer-for-private-ai',
  'anonymous-vs-private-ai',
  'trust-without-a-middleman',
  'dont-trust-the-tee-label',
  'antseed-points',
]);

/** A post's share image (PNG or JPEG, for social cards) has a WebP twin beside it for the page (covers.test.ts). */
const webpOf = (image: string) => image.replace(/\.(png|jpe?g)$/, '.webp');

function coverFor(permalink: string, frontMatterImage?: string): string {
  const slug = permalink.replace(/\/$/, '').split('/').pop() ?? '';
  if (COVER_SLUGS.has(slug)) return `/img/blog/covers/${slug}.svg`;
  if (frontMatterImage) return webpOf(frontMatterImage);
  return '/img/blog/covers/default.svg';
}

function formatDate(iso: string): string | null {
  const date = new Date(iso);
  if (date.getFullYear() >= PINNED_YEAR) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export default function BlogPostItems({items}: Props): ReactNode {
  return (
    <div className={styles.grid}>
      {items.map(({content}, i) => {
        const {metadata} = content;
        const {permalink, title, description, date, readingTime, tags} = metadata;
        const formatted = formatDate(date);
        const featured = i === 0;
        const cover = coverFor(permalink, metadata.frontMatter.image as string | undefined);
        return (
          <div
            key={permalink}
            className={featured ? styles.cellFeatured : undefined}
            style={{'--rv-i': i % COLUMNS} as CSSProperties}
            data-rv={i < COLUMNS ? 'lead' : ''}>
            <Link to={permalink} className={`${styles.card} ${featured ? styles.cardFeatured : ''}`}>
              <span className={styles.cover}>
                <img src={cover} alt="" {...(featured ? {fetchPriority: 'high'} as const : {loading: 'lazy'} as const)} />
                {tags[0] && <span className={styles.category}>{tags[0].label}</span>}
              </span>
              <p className={styles.meta}>
                {formatted ?? 'Featured'}
                {readingTime ? <span> · {Math.ceil(readingTime)} min read</span> : null}
              </p>
              <h2 className={styles.cardTitle}>{title}</h2>
              {description && <p className={styles.cardDesc}>{description}</p>}
              <div className={styles.cardFoot}>
                <span className={styles.readMore}>
                  Read more <span aria-hidden="true">→</span>
                </span>
              </div>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
