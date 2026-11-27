import type {CSSProperties, JSX, ReactNode} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import {Actions, Section, SectionHead, Wash, type SecondLine, type Title} from '../components';
import {paintingPreloads, type Painting} from '../lib/paintings';
import styles from './FirstScreen.module.css';

export type FirstScreenPainting = Painting & {
  /** Accessible description of the painting. */
  label?: string;
  /** The background position kept in view when the painting is cropped (default centred). */
  focus?: string;
};

/** Spacing in the offer, px: eyebrow to title, title to sub line, sub line to buttons. */
export type OfferGaps = readonly [title: number, sub: number, actions: number];

/**
 * Below 1200px, the offer stacked over the painting inside a dotted rail, as the sections under it (instead of across the whole
 * width): 96px over the offer and 56px under it on tablets, 72px and 40px on phones.
 */
export type RailStack = {
  /** The painting's aspect on tablets (default 16 / 9) and phones (default 4 / 3). */
  ratio?: string;
  phoneRatio?: string;
  /** The background position kept in view, on tablets and phones (default the painting's focus). */
  focus?: string;
  phoneFocus?: string;
  /** The painting inset from the rail's sides (16px, the rail's margin on phones) with round corners, 48px under the offer on tablets
   *  and 20px over the next section. */
  inset?: boolean;
  /** The title on tablets: `large` 56px, `tight` 45px. */
  tabletTitle?: 'large' | 'tight';
  /** On phones the title as large as lets its longest line hold (at most 40px). */
  fluidPhoneTitle?: boolean;
  /** The sub line's widest, px (default 540 on tablets, none on phones). */
  subWidth?: number;
};

/** `tight`: 45px from 1200px, at most 544px wide. `long`: 40px, and 34px on phones, for a long title. */
export type FirstScreenTitleSize = 'default' | 'tight' | 'long';

type Props = {
  cmp: string;
  titleId: string;
  eyebrow: ReactNode;
  title: Title;
  /** Black instead of the text colour. */
  strong?: boolean;
  titleSize?: FirstScreenTitleSize;
  /** Where the title's grey part goes (`block`: its own balanced line). */
  secondLine?: SecondLine;
  sub: ReactNode;
  /** From 1200px: the sub line's widest and its distance under the title, px. */
  subWidth?: number;
  subGap?: number;
  /** Buttons, a command to copy… */
  actions: ReactNode;
  /** On phones, the buttons share the full row. */
  fillActions?: boolean;
  /** The offer only as wide as its widest line, so filled buttons stop with the sub line. */
  fit?: boolean;
  /** A small line under the actions. */
  note?: ReactNode;
  /** The offer's widest, px. */
  textWidth?: number;
  painting: FirstScreenPainting;
  /** Lowest height of the screen under 1200px wide, px. */
  minHeight?: number;
  /** From 1200px wide, the rail's surface behind the offer instead of the page colour. */
  onRail?: boolean;
  /** A band inside the same section, under the screen, on the rail (figures). */
  below?: ReactNode;
  /** Below 1200px, stack inside a rail instead of across the whole width. */
  railStack?: RailStack;
  /** On phones the title as large as lets its longest line hold (at most 40px), as `railStack.fluidPhoneTitle`. */
  fluidPhoneTitle?: boolean;
  /** The offer's spacing side by side under 1200px (default 16, 12, 36), stacked on a tablet (default: as side by side) and on
   *  phones (default 16, 16, 28). */
  gaps?: {side?: OfferGaps; stacked?: OfferGaps; phone?: OfferGaps};
  /** The painting's aspect when stacked across the whole width on a tablet (761–899px; default square). */
  tabletRatio?: string;
  /** Page-specific hooks: on the section, the title and the sub line; on the screen's grid, its offer column and its painting. */
  className?: string;
  titleClassName?: string;
  subClassName?: string;
  gridClassName?: string;
  textClassName?: string;
  panelClassName?: string;
  /** Drawn over the painting (glass, a film). */
  children?: ReactNode;
};

const MIN_HEIGHT = 520;

/** The offer on the pages for one audience (agents, apps, coding, privacy): a black title, a narrower column, and on phones the
 *  buttons sharing the full row, as on the other first screens. */
export const AUDIENCE_OFFER = {strong: true, textWidth: 560, subWidth: 500, fillActions: true} as const;

const px = (n: number) => `${n}px`;

function gapVars(name: string, gaps?: OfferGaps): Record<string, string> {
  if (!gaps) return {};
  const [title, sub, actions] = gaps;
  return {[`--${name}-title`]: px(title), [`--${name}-sub`]: px(sub), [`--${name}-actions`]: px(actions)};
}

/** Only what a page sets: the stylesheet holds the defaults. */
function screenVars({minHeight, textWidth, gaps, tabletRatio, railStack, focus}: {
  minHeight: number;
  textWidth?: number;
  gaps?: Props['gaps'];
  tabletRatio?: string;
  railStack?: RailStack;
  focus?: string;
}): CSSProperties {
  const entries: Record<string, string | undefined> = {
    '--screen-min': px(minHeight),
    '--text-width': textWidth === undefined ? undefined : px(textWidth),
    '--tablet-ratio': tabletRatio,
    '--focus': focus,
    '--rail-ratio': railStack?.ratio,
    '--rail-phone-ratio': railStack?.phoneRatio,
    '--rail-focus': railStack?.focus,
    '--rail-phone-focus': railStack?.phoneFocus,
    '--rail-sub-width': railStack?.subWidth === undefined ? undefined : px(railStack.subWidth),
    ...gapVars('side', gaps?.side),
    ...gapVars('stacked', gaps?.stacked),
    ...gapVars('phone', gaps?.phone),
  };
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)) as CSSProperties;
}

/**
 * A page's first screen across the whole width: the offer (an h1) on the left, starting on the rail's text edge, the painting filling
 * the right half (inset 16px with round corners from 1200px). Short enough that the band under it still shows above the fold; exactly
 * the screen under the nav from 1200px (so not rounded to the dot grid there). Below 900px the offer sits above a square painting
 * (or, with `railStack`, below 1200px inside a rail). The painting is preloaded.
 */
export function FirstScreen({
  cmp,
  titleId,
  eyebrow,
  title,
  strong,
  titleSize = 'default',
  secondLine,
  sub,
  subWidth,
  subGap,
  actions,
  fillActions,
  fit,
  note,
  textWidth,
  painting,
  minHeight = MIN_HEIGHT,
  onRail,
  below,
  railStack,
  fluidPhoneTitle,
  gaps,
  tabletRatio,
  className,
  titleClassName,
  subClassName,
  gridClassName,
  textClassName,
  panelClassName,
  children,
}: Props): JSX.Element {
  return (
    <Section cmp={cmp} bare snap="narrow" labelledBy={titleId} className={clsx(
        styles.screen,
        railStack && styles.railStack,
        railStack?.inset && styles.inset,
        railStack?.tabletTitle && styles[`${railStack.tabletTitle}Tablet`],
        (fluidPhoneTitle || railStack?.fluidPhoneTitle) && styles.fluidPhone,
        className,
      )}
      style={screenVars({minHeight, textWidth, gaps, tabletRatio, railStack, focus: painting.focus})}>
      <Head>
        {paintingPreloads(painting).map(({href, media}) => <link key={href} rel="preload" as="image" href={href} fetchPriority="high" media={media} />)}
      </Head>
      <div className={clsx(styles.grid, !onRail && styles.onPage, fit && styles.fit, gridClassName)}>
        <div className={clsx(styles.text, textClassName)}>
          <SectionHead
            size="page"
            lead
            as="h1"
            id={titleId}
            eyebrow={eyebrow}
            title={title}
            strong={strong}
            secondLine={secondLine}
            sub={sub}
            subWidth={subWidth}
            subGap={subGap}
            className={styles.offer}
            titleClassName={clsx(styles.title, titleSize !== 'default' && styles[titleSize], titleClassName)}
            subClassName={clsx(styles.sub, subClassName)}>
            <Actions reveal="lead" fill={fillActions} className={styles.actions}>{actions}</Actions>
            {note && <p className={styles.note} data-rv="lead">{note}</p>}
          </SectionHead>
        </div>
        <div className={clsx(styles.panel, panelClassName)}>
          <Wash
            eager
            unveil
            className={styles.painting}
            day={painting.day}
            night={painting.night}
            dayPhone={painting.dayPhone}
            nightPhone={painting.nightPhone}
            label={painting.label}>
            {children}
          </Wash>
        </div>
      </div>
      {below && <div className={styles.rail}>{below}</div>}
    </Section>
  );
}
