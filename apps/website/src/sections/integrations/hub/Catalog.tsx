import {useId, useState, type JSX} from 'react';
import Link from '@docusaurus/Link';
import {Section} from '../../../components';
import {LinkRows, type LinkRow} from '../../../parts/LinkRows';
import {PixelIcon} from '../../../parts/PixelIcon';
import {Ticks} from '../../../parts/Ticks';
import {CATEGORY_LABELS, CATEGORY_TAGLINES, STATUS_LABELS, type Integration} from '../../../integrations/integrations';
import {IntegrationMark} from '../IntegrationMark';
import {CATEGORY_ICON} from './categoryIcons';
import {useCatalog, type CatalogGroup} from './useCatalog';
import styles from './Catalog.module.css';

const categoryId = (c: string) => `cat-${c}`;

function toRow(i: Integration): LinkRow {
  const status = i.status === 'verified' ? '' : ` · ${STATUS_LABELS[i.status]}`;
  return {
    name: i.name,
    href: `/integrations/${i.slug}/`,
    text: <Ticks>{i.oneLiner}</Ticks>,
    action: `${i.setupMinutes} min${status}`,
    mark: <IntegrationMark integration={i} />,
    label: `${i.name} setup guide`,
  };
}

function Group({group}: {group: CatalogGroup}): JSX.Element {
  const id = categoryId(group.category);
  return (
    <section className={styles.group} id={id} aria-labelledby={`${id}-title`}>
      <header className={styles.groupHead} data-rv="">
        <h2 id={`${id}-title`} className={styles.groupTitle}>
          <PixelIcon name={CATEGORY_ICON[group.category]} className={styles.groupIcon} />
          {CATEGORY_LABELS[group.category]}
          <span className={styles.groupCount}>{group.items.length}</span>
        </h2>
        <p className={styles.groupLine}>{CATEGORY_TAGLINES[group.category]}</p>
      </header>
      <LinkRows rows={group.items.map(toRow)} columns={2} />
    </section>
  );
}

/** Every integration by category, with a search over names and one-liners and a jump to each category. */
export default function Catalog(): JSX.Element {
  const [query, setQuery] = useState('');
  const {groups, count} = useCatalog(query);
  const searchId = useId();
  return (
    <Section cmp="integrations/catalog" id="catalog" label="Integrations" pad="all">
      <div className={styles.controls}>
        <nav className={styles.jump} aria-label="Jump to a category">
          {groups.map((g) => (
            <a key={g.category} href={`#${categoryId(g.category)}`} className={styles.jumpLink}>
              {CATEGORY_LABELS[g.category]} <span className={styles.jumpCount}>{g.items.length}</span>
            </a>
          ))}
        </nav>
        <label htmlFor={searchId} className={styles.searchLabel}>Search integrations</label>
        <input
          id={searchId}
          type="search"
          className={styles.search}
          placeholder="Search integrations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p className={styles.status} aria-live="polite">{query ? `${count} match${count === 1 ? '' : 'es'}` : ''}</p>
      {count === 0 ? (
        <p className={styles.empty}>
          No match for “{query}”. Anything that speaks the Anthropic or OpenAI API works: see the <Link to="/integrations/curl/">raw HTTP guide</Link>.
        </p>
      ) : groups.map((g) => <Group key={g.category} group={g} />)}
    </Section>
  );
}
