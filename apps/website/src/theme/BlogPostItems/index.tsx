/**
 * BlogPostItems — card grid for the blog index and tag pages, styled
 * strictly with the homepage component recipes (stepCard surfaces,
 * display-font headings, mono meta line, Reveal stagger). Individual
 * post pages are untouched.
 */
import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import type {Props} from '@theme/BlogPostItems';
import {ArrowRight, Reveal} from '@site/src/components/ui';
import styles from './styles.module.css';

/* Posts pinned to the top use a far-future date (the 2099 hack) — showing
   that date would look broken, so those cards get a "Featured" label. */
const PINNED_YEAR = 2090;

/* Every post's frontmatter points at the shared /og-image.jpg — not real
   cover art. Cards instead use the generated per-post covers in
   /img/blog/covers (one SVG per slug, brand illustration language);
   a real per-post frontmatter image overrides this. */
const DEFAULT_OG_IMAGE = '/og-image.jpg';

const COVER_SLUGS = new Set([
  'when-does-prompt-caching-save-money',
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
]);

function coverFor(permalink: string, frontMatterImage?: string): string {
  if (frontMatterImage && frontMatterImage !== DEFAULT_OG_IMAGE) return frontMatterImage;
  const slug = permalink.replace(/\/$/, '').split('/').pop() ?? '';
  return `/img/blog/covers/${COVER_SLUGS.has(slug) ? slug : 'default'}.svg`;
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
          <Reveal
            key={permalink}
            delay={(i % 3) * 100}
            className={featured ? styles.cellFeatured : undefined}>
            <Link to={permalink} className={`${styles.card} ${featured ? styles.cardFeatured : ''}`}>
              <span className={styles.cover}>
                <img src={cover} alt="" loading="lazy" />
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
                  Read more
                  <ArrowRight size={16} />
                </span>
              </div>
            </Link>
          </Reveal>
        );
      })}
    </div>
  );
}
