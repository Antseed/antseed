import type {CSSProperties, JSX, ReactNode} from 'react';
import clsx from 'clsx';
import styles from './Heading.module.css';

/** A title in two tones: the first part in ink, the second in grey. A plain string is all ink. */
export type Title = ReactNode | readonly [ReactNode, ReactNode];

/** Where a two-tone title's grey part goes: on the same line, after a line break, or as its own balanced block. */
export type SecondLine = 'inline' | 'break' | 'block';

/** Reveal on scroll (`true`), or `'lead'`: a first screen's part, fading up by CSS from the first paint without waiting for script. */
export type Reveal = boolean | 'lead';

const isPair = (t: Title): t is readonly [ReactNode, ReactNode] => Array.isArray(t) && t.length === 2;

type HeadingProps = {
  title: Title;
  as?: 'h1' | 'h2' | 'h3';
  /** Black instead of the text colour (product titles). */
  strong?: boolean;
  secondLine?: SecondLine;
  /** Reveal on its own (SectionHead reveals its parts one by one). */
  reveal?: Reveal;
  id?: string;
  className?: string;
};

const rv = (reveal?: Reveal) => (reveal ? {'data-rv': reveal === 'lead' ? 'lead' : ''} : undefined);

export function Heading({title, as: Tag = 'h2', strong, secondLine = 'inline', reveal, id, className}: HeadingProps): JSX.Element {
  return (
    <Tag id={id} className={clsx(styles.title, strong && styles.strong, className)} {...rv(reveal)}>
      {isPair(title) ? (
        <>
          {title[0]}
          {secondLine === 'break' ? <br /> : secondLine === 'inline' && ' '}
          <span className={clsx(styles.second, secondLine === 'block' && styles.block)}>{title[1]}</span>
        </>
      ) : title}
    </Tag>
  );
}

type TextProps = {children: ReactNode; reveal?: Reveal; className?: string; style?: CSSProperties};

export function Eyebrow({children, reveal, className, style}: TextProps): JSX.Element {
  return <p className={clsx(styles.eyebrow, className)} style={style} {...rv(reveal)}>{children}</p>;
}

export function Sub({children, reveal, className, style}: TextProps): JSX.Element {
  return <p className={clsx(styles.sub, className)} style={style} {...rv(reveal)}>{children}</p>;
}

/** `default`: a section head. `compact`: 40px titles from 1200px, over a row of cards. `page`: a first screen's offer (an h1). */
export type HeadSize = 'default' | 'compact' | 'page';

type SectionHeadProps = Omit<HeadingProps, 'reveal' | 'className'> & {
  eyebrow?: ReactNode;
  sub?: ReactNode;
  size?: HeadSize;
  center?: boolean;
  /** The rail's side margin, on the head only. */
  padX?: boolean;
  /** From 1200px (`page` size): the sub line's widest, and its distance under the title, px. */
  subWidth?: number;
  subGap?: number;
  className?: string;
  eyebrowClassName?: string;
  titleClassName?: string;
  subClassName?: string;
  /** A first screen's offer: its parts fade up from the first paint instead of on scroll. */
  lead?: boolean;
  /** Under the sub line (actions). */
  children?: ReactNode;
};

/**
 * Eyebrow, title and sub line, revealed on scroll one after another. From 1200px the title and sub line sit 16px apart and the sub
 * line is at most 640px wide (or `subWidth` on the `page` size).
 */
export function SectionHead({
  eyebrow,
  sub,
  size = 'default',
  center,
  padX,
  subWidth,
  subGap,
  className,
  eyebrowClassName,
  titleClassName,
  subClassName,
  lead,
  children,
  secondLine = 'break',
  ...heading
}: SectionHeadProps): JSX.Element {
  const reveal: Reveal = lead ? 'lead' : true;
  const style = {
    ...(subWidth !== undefined && {'--sub-width': `${subWidth}px`}),
    ...(subGap !== undefined && {'--sub-gap': `${subGap}px`}),
  } as CSSProperties;
  return (
    <header
      className={clsx(styles.head, size === 'page' ? styles.page : styles.wide, size === 'compact' && styles.compact, center && styles.center, padX && styles.padX, className)}
      style={style}>
      {eyebrow && <Eyebrow reveal={reveal} className={eyebrowClassName}>{eyebrow}</Eyebrow>}
      <Heading reveal={reveal} secondLine={secondLine} className={titleClassName} {...heading} />
      {sub && <Sub reveal={reveal} className={subClassName}>{sub}</Sub>}
      {children}
    </header>
  );
}
