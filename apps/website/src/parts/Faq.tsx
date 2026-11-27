import type {CSSProperties, JSX, MouseEvent, ReactNode} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import {Heading, Section, type Title} from '../components';
import {faqJsonLd} from '../lib/faqJsonLd';
import {useDetailsHashLink} from '../lib/useDetailsHashLink';
import {plainText} from '../lib/plainText';
import styles from './Faq.module.css';

export type FaqItem = {
  /** Anchor for links straight to this answer. */
  id?: string;
  question: string;
  /** Text, or rich copy (inline code, links); the structured data takes its plain text. */
  answer: ReactNode;
  link?: {href: string; label: string};
};

type Props = {
  /** Comparison key, `<page>/faq`. */
  cmp: string;
  items: readonly FaqItem[];
  title?: Title;
  id?: string;
  titleId?: string;
  /** Emit the FAQPage JSON-LD (on by default). */
  jsonLd?: boolean;
  /** From 1200px: the space above and below, px (120 by default). */
  widePadding?: number;
  /** On phones: the space between the title and the questions, px (40 by default). */
  phoneGap?: number;
  className?: string;
};

const DEFAULT_TITLE: Title = ['Frequently asked', 'questions.'];

/** A page's questions: the title beside an accordion (one open at a time), with its FAQPage structured data. */
export function Faq({cmp, items, title = DEFAULT_TITLE, id = 'faq', titleId = `${id}-h`, jsonLd = true, widePadding, phoneGap, className}: Props): JSX.Element {
  const ld = faqJsonLd(items.map(({question, answer}) => ({q: question, a: plainText(answer)})));
  const style = {
    ...(widePadding !== undefined && {'--faq-wide-pad': `${widePadding}px`}),
    ...(phoneGap !== undefined && {'--faq-phone-gap': `${phoneGap}px`}),
  } as CSSProperties;
  useDetailsHashLink(id);
  return (
    <Section cmp={cmp} id={id} labelledBy={titleId} pad="all" className={clsx(styles.faq, className)} railClassName={styles.rail} style={style}>
      {jsonLd && <Head><script type="application/ld+json">{JSON.stringify(ld)}</script></Head>}
      <div data-rv="">
        <Heading title={title} secondLine="break" id={titleId} className={styles.title} />
      </div>
      <div>
        {items.map((item, i) => <Question key={item.question} item={item} open={i === 0} group={id} />)}
      </div>
    </Section>
  );
}

/** How long a tapped question is held in place: the answer closing above it shrinks over .25s (Faq.module.css). */
const HOLD_MS = 400;
/** The visitor scrolling on their own: the hold lets go at once. */
const SCROLL_INTENT = ['wheel', 'touchmove', 'keydown'] as const;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** Lets go of the question being held, if any. */
let releaseHold: (() => void) | null = null;

/** Whether opening this question closes an open one above it in its group. */
function closesOneAbove(details: HTMLDetailsElement): boolean {
  if (details.open) return false;   // this tap closes it: nothing above moves
  const group = details.parentElement?.querySelectorAll<HTMLDetailsElement>(':scope > details[open]') ?? [];
  return [...group].some((d) => d !== details && Boolean(d.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING));
}

/**
 * Opening a question closes the open one; when that one sits above, the page shrinks above the tapped question and pulls it from
 * under the finger. Until the closing answer settles, the scroll follows it so the tapped question stays where it was, unless the
 * visitor scrolls on their own first.
 */
function holdInPlace(e: MouseEvent<HTMLElement>) {
  releaseHold?.();
  const summary = e.currentTarget;
  const details = summary.parentElement;
  if (!(details instanceof HTMLDetailsElement) || !closesOneAbove(details)) return;
  const top = summary.getBoundingClientRect().top;
  const until = performance.now() + HOLD_MS;
  let frame = 0;
  const intent = (ev: Event) => {
    if (!(ev instanceof KeyboardEvent) || SCROLL_KEYS.has(ev.key)) release();
  };
  const release = () => {
    cancelAnimationFrame(frame);
    for (const type of SCROLL_INTENT) window.removeEventListener(type, intent, {capture: true});
    if (releaseHold === release) releaseHold = null;
  };
  const follow = () => {
    const moved = summary.getBoundingClientRect().top - top;
    if (moved) window.scrollBy({top: moved, behavior: 'instant'});
    if (performance.now() < until) frame = requestAnimationFrame(follow);
    else release();
  };
  for (const type of SCROLL_INTENT) window.addEventListener(type, intent, {capture: true, passive: true});
  releaseHold = release;
  frame = requestAnimationFrame(follow);
}

function Question({item, open, group}: {item: FaqItem; open: boolean; group: string}): JSX.Element {
  useBrokenLinks().collectAnchor(item.id);
  return (
    <details id={item.id} name={group} open={open} className={styles.question} data-rv="">
      <summary className={styles.summary} onClick={holdInPlace}>{item.question}</summary>
      <div className={styles.answer}>
        <p className={styles.text}>{item.answer}</p>
        {item.link && <Link className={styles.link} to={item.link.href}>{item.link.label}</Link>}
      </div>
    </details>
  );
}
