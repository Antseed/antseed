import {useRef, type CSSProperties, type JSX, type ReactNode} from 'react';
import clsx from 'clsx';
import {useInView} from '../lib/useInView';
import {useUnveil} from '../lib/useUnveil';
import {useWashTrail} from '../lib/washTrail/useWashTrail';
import {PHONE_PAINTINGS} from '../lib/paintings';
import styles from './Wash.module.css';

const LOAD_MARGIN = '1200px';

type Props = {
  /** Day painting URL. */
  day: string;
  /** Night painting URL; the day one is reused when omitted. */
  night?: string;
  /** Phone cuts of the two (lib/paintings.ts), shown on screens up to 560px wide. */
  dayPhone?: string;
  nightPhone?: string;
  /** First screen: the painting is drawn as an image, so the browser ties the page's largest paint to its preload (FirstScreen).
   *  Otherwise it is the background, requested within 1200px of the viewport. */
  eager?: boolean;
  /** Play the painting's arrival the first time it is seen. */
  unveil?: boolean;
  /** With `unveil`: a new value plays the arrival again (a newly chosen tab). */
  replayKey?: string | number;
  /** The cursor's LED trail over the painting (on by default; off where something else draws on the panel). */
  trail?: boolean;
  /** Accessible description; makes the panel an image. */
  label?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** Reveal-on-scroll role, e.g. "panel". */
  reveal?: '' | 'panel';
};

/** One theme's painting as an image (its phone cut on phones). Lazy, so the other theme's is never fetched while hidden. */
function Picture({src, phone, className}: {src: string; phone?: string; className: string}): JSX.Element {
  return (
    <picture className={className}>
      {phone && <source media={PHONE_PAINTINGS} srcSet={phone} />}
      <img src={src} alt="" loading="lazy" fetchPriority="high" decoding="async" />
    </picture>
  );
}

/** A painted panel. Only the current theme's painting is ever downloaded (CSS picks one of the two). */
export function Wash({day, night, dayPhone, nightPhone, eager, unveil, replayKey, trail = true, label, className, style, children, reveal}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref, {rootMargin: LOAD_MARGIN, once: true});
  useUnveil(ref, !!unveil, replayKey);
  useWashTrail(ref, trail);
  const load = eager || near;
  const image = (url?: string) => (url ? (load ? `url(${url})` : 'none') : undefined);
  // the variables also tell the arrival and the trail which painting is on screen
  const vars = {
    '--wash': image(day),
    '--wash-night': image(night),
    '--wash-phone': image(dayPhone),
    '--wash-night-phone': image(nightPhone),
    ...(eager && {backgroundImage: 'none'}),
    ...style,
  } as CSSProperties;
  return (
    <div
      ref={ref}
      className={clsx(styles.wash, eager && styles.eager, className)}
      style={vars}
      role={label ? 'img' : undefined}
      aria-label={label}
      data-rv={reveal}
      // rendered waiting so the plain state is there from the first paint; the CSS applies it only under html[data-motion]
      data-unveil={unveil ? 'wait' : undefined}>
      {eager && <Picture src={day} phone={dayPhone} className={clsx(styles.picture, night && styles.day)} />}
      {eager && night && <Picture src={night} phone={nightPhone} className={clsx(styles.picture, styles.night)} />}
      {children}
    </div>
  );
}
