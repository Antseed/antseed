import {useMemo, useState, useEffect, type JSX} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import {
  integrations,
  CATEGORY_LABELS,
  CATEGORY_TAGLINES,
  CATEGORY_ORDER,
  STATUS_LABELS,
  type IntegrationCategory,
  type Integration,
} from '../integrations/integrations';
import styles from '../integrations/integrations.module.css';
import {ArrowRight, Button, FinalCta, PageHero, Section, Ticks} from '../components/ui';
import {SkillChip} from '../components/SkillChip';
import {HugeiconsIcon} from '@hugeicons/react';
import {
  SourceCodeIcon,
  NeuralNetworkIcon,
  FrameworksIcon,
  ComputerTerminal01Icon,
} from '@hugeicons/core-free-icons';

/* --------------------------- Category icons --------------------------- *
 * Hugeicons, stroke style, 20x20. Centralized so we don't sprinkle
 * ASCII glyphs around the UI.
 * -------------------------------------------------------------------- */

const CATEGORY_ICON = {
  'coding-agent': SourceCodeIcon,
  'agent-platform': NeuralNetworkIcon,
  framework: FrameworksIcon,
  cli: ComputerTerminal01Icon,
} as const;

function CategoryIcon({category}: {category: IntegrationCategory}) {
  return <HugeiconsIcon icon={CATEGORY_ICON[category]} size={20} strokeWidth={1.6} />;
}

function IntegrationCard({i}: {i: Integration}) {
  const mutedLogo = i.slug === 'genlayer-studio' || i.slug === 'langchain-python';

  return (
    <Link to={`/integrations/${i.slug}`} className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.logoWrap}>
          {i.logo ? (
            <img
              src={`/logos/${i.logo}`}
              alt=""
              className={`${styles.logoImg}${mutedLogo ? ' ' + styles.mutedLogoImg : ''}`}
            />
          ) : (
            <span className={styles.logoGlyph}>{i.glyph ?? i.name[0]}</span>
          )}
        </div>
        <div className={styles.cardMeta}>
          <h3 className={styles.cardTitle}>{i.name}</h3>
        </div>
      </div>
      <p className={styles.cardLine}><Ticks>{i.oneLiner}</Ticks></p>
      <div className={styles.cardFooter}>
        <span className={styles.cardSetup}>{i.setupMinutes} min</span>
        {i.status !== 'verified' && (
          <span className={styles.cardSetup}>{STATUS_LABELS[i.status]}</span>
        )}
        <span className={styles.cardArrow}><ArrowRight size={18} /></span>
      </div>
    </Link>
  );
}

function CategorySection({
  category,
  items,
}: {
  category: IntegrationCategory;
  items: Integration[];
}) {
  if (items.length === 0) return null;
  return (
    <section className={styles.catSection} id={`cat-${category}`}>
      <header className={styles.catHeader}>
        <div className={styles.catGlyph} aria-hidden="true">
          <CategoryIcon category={category} />
        </div>
        <div className={styles.catHeaderText}>
          <div className={styles.catTitleRow}>
            <h2 className={styles.catTitle}>{CATEGORY_LABELS[category]}</h2>
            <span className={styles.catCount}>
              {items.length} {items.length === 1 ? 'tool' : 'tools'}
            </span>
          </div>
          <p className={styles.catTagline}>{CATEGORY_TAGLINES[category]}</p>
        </div>
      </header>
      <div className={styles.catGrid}>
        {items.map((i) => (
          <IntegrationCard key={i.slug} i={i} />
        ))}
      </div>
    </section>
  );
}

export default function ConnectHub(): JSX.Element {
  const [query, setQuery] = useState('');

  const grouped = useMemo<Record<IntegrationCategory, Integration[]>>(() => {
    const out = {} as Record<IntegrationCategory, Integration[]>;
    for (const cat of CATEGORY_ORDER) out[cat] = [];
    for (const i of integrations) {
      if (query.trim()) {
        const q = query.toLowerCase();
        if (
          !i.name.toLowerCase().includes(q) &&
          !i.oneLiner.toLowerCase().includes(q) &&
          !CATEGORY_LABELS[i.category].toLowerCase().includes(q)
        )
          continue;
      }
      out[i.category].push(i);
    }
    return out;
  }, [query]);

  const totalShown = useMemo(
    () => Object.values(grouped).reduce((n, arr) => n + arr.length, 0),
    [grouped],
  );

  // Smooth-scroll to anchor on click. Avoids the default jumpy behavior on
  // long pages and accounts for the fixed navbar height.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a[data-jump]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const id = anchor.getAttribute('data-jump');
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({top, behavior: 'smooth'});
      history.replaceState(null, '', `#${id}`);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <Layout
      title="Integrations"
      description="Every way to use Antseed: coding agents, autonomous agents, editors, SDKs, frameworks, partner platforms. Anthropic and OpenAI compatible. Drop-in via localhost:8377.">
      <Head>
        <meta property="og:title" content="Integrations | Antseed" />
        <meta property="og:description" content="Every way to use Antseed: coding agents, autonomous agents, editors, SDKs, frameworks, partner platforms. Anthropic and OpenAI compatible." />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              {'@type': 'ListItem', position: 1, name: 'Home', item: 'https://antseed.com/'},
              {'@type': 'ListItem', position: 2, name: 'Integrations', item: 'https://antseed.com/integrations/'},
            ],
          })}
        </script>
      </Head>

      <PageHero
        kicker="Integrations"
        title="One local endpoint. Every tool you already use."
        lead={
          <>
            Your local endpoint at <code>http://localhost:8377</code> is OpenAI and Anthropic
            compatible and translates between the two on the fly. Pick your tool below.
          </>
        }>
        <Button to="/docs/install" arrow>Install the CLI</Button>
        <SkillChip size="md" />
      </PageHero>

      <Section tone="tinted" width="xl" compact>
        <nav className={styles.jumpNav} aria-label="Jump to category">
          {CATEGORY_ORDER.map((cat) => {
            const count = grouped[cat].length;
            if (count === 0) return null;
            return (
              <a
                key={cat}
                href={`#cat-${cat}`}
                data-jump={`cat-${cat}`}
                className={styles.jumpLink}>
                <span className={styles.jumpIcon}>
                  <CategoryIcon category={cat} />
                </span>
                <span className={styles.jumpLabel}>{CATEGORY_LABELS[cat]}</span>
                <span className={styles.jumpCount}>{count}</span>
              </a>
            );
          })}
        </nav>

        <div className={styles.searchRow}>
          <input
            type="search"
            placeholder="Search integrations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={styles.search}
          />
          {query && (
            <span className={styles.resultCount}>
              {totalShown} match{totalShown === 1 ? '' : 'es'}
            </span>
          )}
        </div>
      </Section>

      <Section width="xl">
        <div className={styles.sections}>
          {totalShown === 0 ? (
            <p className={styles.noResults}>
              No matches for <strong>{query}</strong>. Try the{' '}
              <Link to="/integrations/curl">raw HTTP page</Link> - anything that speaks Anthropic or
              OpenAI works.
            </p>
          ) : (
            CATEGORY_ORDER.map((cat) => (
              <CategorySection key={cat} category={cat} items={grouped[cat]} />
            ))
          )}
        </div>
      </Section>

      <Section tone="tinted">
        <div className={styles.bottomBlock}>
          <div>
            <h3>Don't see your tool?</h3>
            <p>
              If your tool accepts an Anthropic or OpenAI base URL, Antseed already works with
              it - see the <Link to="/integrations/curl">raw HTTP page</Link> for the contract. Want
              it added here? Open a PR on{' '}
              <a
                href="https://github.com/AntSeed/antseed/blob/main/apps/website/src/integrations/integrations.ts"
                target="_blank"
                rel="noopener noreferrer">
                integrations.ts
              </a>
              .
            </p>
          </div>
          <div>
            <h3>Building an integration?</h3>
            <p>
              Read the <Link to="/docs/guides/using-the-api">API guide</Link>, give your agent{' '}
              <a href="/skill.md">the skill</a>, and ping us in{' '}
              <a href="https://t.me/antseed" target="_blank" rel="noopener noreferrer">
                Telegram
              </a>{' '}
              for partner verification.
            </p>
          </div>
        </div>
      </Section>

      <FinalCta
        title="Point your tools at Antseed"
        sub="Install once, set one base URL, and keep the workflow you already have."
        note={
          <>
            <a href="/docs/guides/using-the-api">Read the API guide</a>
            <a href="/skill.md">Read the skill</a>
          </>
        }>
        <Button to="/docs/install" variant="white" size="lg" arrow>Install the CLI</Button>
        <SkillChip dark />
      </FinalCta>
    </Layout>
  );
}
