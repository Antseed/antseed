import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import clsx from 'clsx';
import MiniSearch, {type SearchResult} from 'minisearch';
import {useHistory} from '@docusaurus/router';
import type {SearchEntry} from '@site/plugins/docs-search';
import styles from './styles.module.css';

/**
 * Docs search (navbar `type: 'search'`). A "Search docs" trigger opens a
 * command-palette modal; ⌘K / Ctrl+K or "/" open it from anywhere. Results
 * update on every keystroke with prefix and typo-tolerant matching, ranked
 * section headings first, then page titles, then body text.
 *
 * The index comes from plugins/docs-search.ts and is fetched the first time
 * the modal opens, so it costs nothing on page load.
 */

// Short badge text and tone for each sidebar category.
const CATEGORY_BADGES: Record<string, {label: string; tone: string}> = {
  'Getting Started': {label: 'Start', tone: 'green'},
  'Gateway Console': {label: 'Gateway', tone: 'green'},
  'Desktop App': {label: 'Desktop', tone: 'teal'},
  'Connect Tools & Agents': {label: 'Connect', tone: 'teal'},
  'Security & Privacy': {label: 'Security', tone: 'clay'},
  Providers: {label: 'Providers', tone: 'blue'},
  Plugins: {label: 'Plugins', tone: 'blue'},
  Protocol: {label: 'Protocol', tone: 'violet'},
  Reference: {label: 'Reference', tone: 'gray'},
  Papers: {label: 'Paper', tone: 'gray'},
  Archive: {label: 'Archive', tone: 'gray'},
};

const MAX_RESULTS = 20;

// Lowercases and folds plurals ("budgets" → "budget") so a typo in either
// form still lands within fuzzy distance.
function processTerm(term: string): string {
  const t = term.toLowerCase();
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
}

type Hit = SearchResult & SearchEntry;

let indexPromise: Promise<MiniSearch<SearchEntry>> | null = null;

function loadIndex(): Promise<MiniSearch<SearchEntry>> {
  indexPromise ??= import('@generated/docs-search/default/search-index.json').then((mod) => {
    const entries = (mod.default ?? mod) as SearchEntry[];
    const search = new MiniSearch<SearchEntry>({
      idField: 'url',
      fields: ['heading', 'page', 'summary', 'text'],
      storeFields: ['page', 'heading', 'category', 'summary', 'url'],
      processTerm,
      searchOptions: {
        boost: {heading: 4, page: 3, summary: 1.5},
        prefix: true,
        fuzzy: (term) => (term.length > 3 ? 0.2 : false),
        combineWith: 'AND',
        processTerm,
      },
    });
    search.addAll(entries);
    return search;
  });
  return indexPromise;
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

// Wraps the matched terms of `text` in <mark>.
function highlight(text: string, terms: string[]): React.ReactNode {
  if (!terms.length) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

function SearchIcon({className}: {className?: string}) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8.75" cy="8.75" r="5.75" />
      <path d="M13 13l4 4" />
    </svg>
  );
}

function SearchModal({onClose}: {onClose: () => void}) {
  const history = useHistory();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [index, setIndex] = useState<MiniSearch<SearchEntry> | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
    loadIndex().then(setIndex);
    const {overflow} = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim();
    if (!index || !q) return [];
    return (index.search(q) as Hit[]).slice(0, MAX_RESULTS);
  }, [index, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({block: 'nearest'});
  }, [active]);

  const open = useCallback(
    (hit: Hit) => {
      onClose();
      history.push(hit.url);
    },
    [history, onClose],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' && hits.length) {
      event.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (event.key === 'ArrowUp' && hits.length) {
      event.preventDefault();
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter' && hits[active]) {
      event.preventDefault();
      open(hits[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const q = query.trim();
  let body: React.ReactNode;
  if (!q) {
    body = <p className={styles.empty}>Type to search documentation</p>;
  } else if (!index) {
    body = <p className={styles.empty}>Loading…</p>;
  } else if (!hits.length) {
    body = (
      <p className={styles.empty}>
        No results for “<strong>{q}</strong>”
      </p>
    );
  } else {
    body = (
      <ul ref={listRef} className={styles.results} role="listbox" id="docs-search-results">
        {hits.map((hit, i) => {
          const badge = CATEGORY_BADGES[hit.category] ?? {label: hit.category, tone: 'gray'};
          return (
            <li key={hit.url} id={`docs-search-hit-${i}`} data-index={i} role="option"
              aria-selected={i === active}
              className={clsx(styles.hit, i === active && styles.hitActive)}
              onMouseMove={() => setActive(i)}
              onClick={() => open(hit)}>
              <span className={clsx(styles.badge, styles[`tone-${badge.tone}`])}>{badge.label}</span>
              <span className={styles.hitBody}>
                <span className={styles.hitTitle}>{highlight(hit.heading || hit.page, hit.terms)}</span>
                <span className={styles.hitMeta}>
                  {hit.heading ? hit.page : hit.summary || hit.category}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return createPortal(
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Search docs">
        <div className={styles.inputRow}>
          <SearchIcon className={styles.inputIcon} />
          <input ref={inputRef} className={styles.input} type="search" placeholder="Search docs..."
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
            role="combobox" aria-expanded={hits.length > 0} aria-controls="docs-search-results"
            aria-activedescendant={hits.length ? `docs-search-hit-${active}` : undefined}
            autoComplete="off" autoCorrect="off" spellCheck={false} />
          <button type="button" className={styles.kbdButton} onClick={onClose}>Esc</button>
        </div>
        <div className={styles.body}>{body}</div>
        <div className={styles.footer}>
          <span><kbd>↑</kbd><kbd>↓</kbd>Navigate</span>
          <span><kbd>Enter</kbd>Open</span>
          <span><kbd>Esc</kbd>Close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function SearchBar(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [mac, setMac] = useState(true);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    setMac(isMac());
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((o) => !o);
      } else if (event.key === '/' && !typing) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button type="button" className={clsx('docs-search-trigger', styles.trigger)} onClick={() => setOpen(true)}
        onMouseEnter={() => void loadIndex()} aria-label="Search docs">
        <SearchIcon className={styles.triggerIcon} />
        <span className={styles.triggerLabel}>Search docs...</span>
        <kbd className={styles.triggerKbd}>{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {open && <SearchModal onClose={close} />}
    </>
  );
}
