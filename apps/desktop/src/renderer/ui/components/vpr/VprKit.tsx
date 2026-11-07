import { useContext } from 'react';
import type { JSX, ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import { VprNavContext, useVprNavBack } from './VprNavContext';
import { VprHeaderActions } from './VprHeaderActions';
import type { ViewName } from '../../types';
import styles from './VprKit.module.scss';

/**
 * Shared brand-guideline primitives for the Antseed Desktop screens (Figma: Toggle -
 * Switch, Badge, Slider - Center-biased, Default model tiles, search).
 */

export { formatCompactTokens, formatUsdShort } from '../../../core/format';

/** Inner-screen page header: back chevron + screen title. Without an explicit
 * onBack it pops the shell's nav history — returning to whichever screen the
 * user actually came from — and lands on `fallback` when there is none.
 * Passing onBack keeps full control (in-view stages, wizards). */
export function VprBackTitle({ title, onBack, fallback = 'home' }: {
  title: string;
  onBack?: () => void;
  fallback?: ViewName;
}): JSX.Element {
  const historyBack = useVprNavBack(fallback);
  return (
    <button type="button" className={styles.backTitle} onClick={onBack ?? historyBack} title="Back">
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={2} />
      <span title={title}>{title}</span>
    </button>
  );
}

/**
 * Pinned page chrome for inner screens: a fixed header zone (back title on
 * the left, the credits pill on the right, plus optional extra pinned rows
 * like a search field or tabs) above a body that scrolls on its own — so the
 * scrollbar starts below the header, native-app style. The view's root
 * section must add the global `view-pinned-header` class, which turns it
 * into a non-scrolling flex column.
 */
export function VprPage({ title, subtitle, large = false, action, root = false, titleInBody = false, onBack, backFallback, center, header, children }: {
  title: string;
  /** With a subtitle the page opens with the design's large heading, and the bar keeps only Back. */
  subtitle?: string;
  /** The large heading, for a page with no subtitle to give. */
  large?: boolean;
  /** Beside the large heading, like a page's own buttons or status. */
  action?: ReactNode;
  /** Pinned in the middle of the top bar, like the mode switch. */
  center?: ReactNode;
  /** The page shows its own title in the body (a banner): the header keeps only its actions. */
  titleInBody?: boolean;
  /** A top-level screen from the nav rail: a plain title, no back chevron. */
  root?: boolean;
  /** Explicit back handler (in-view stages); omit to pop the nav history. */
  onBack?: () => void;
  /** History-empty fallback when onBack is omitted; defaults to 'home'. */
  backFallback?: ViewName;
  /** Extra rows pinned with the header (e.g. search, tabs). */
  header?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const nav = useContext(VprNavContext);
  const hero = large || Boolean(subtitle);
  return (
    <>
      <div className={styles.pageTop}>
        <div className={styles.pageHeaderRow}>
          {titleInBody || (root && hero) ? <span /> : root
            ? <h1 className={styles.pageTitle}>{title}</h1>
            : <VprBackTitle title={hero ? 'Back' : title} onBack={onBack} fallback={backFallback} />}
          {center ? <div className={styles.pageCenter}>{center}</div> : null}
          <VprHeaderActions onSelectView={nav?.navigate} />
        </div>
        {header ? <div className={styles.pageTopInner}>{header}</div> : null}
      </div>
      <div className={styles.pageBody} data-view-scroll>
        {hero ? (
          <div className={styles.pageHero}>
            <div className={styles.pageHeroRow}>
              <h1 className={styles.pageHeroTitle}>{title}</h1>
              {action ?? null}
            </div>
            {subtitle ? <p className={styles.pageHeroSubtitle}>{subtitle}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    </>
  );
}

export function VprToggle({ checked, onChange, ariaLabel, disabled }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${styles.toggle}${checked ? ` ${styles.toggleOn}` : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleKnob} />
    </button>
  );
}

export type VprBadgeTone = 'green' | 'primary' | 'neutral' | 'type';

const BADGE_TONE_CLASS: Record<VprBadgeTone, string> = {
  green: styles.badgeGreen,
  primary: styles.badgePrimary,
  neutral: styles.badgeNeutral,
  type: styles.badgeType,
};

export function VprBadge({ tone = 'green', children }: {
  tone?: VprBadgeTone;
  children: ReactNode;
}): JSX.Element {
  return <span className={`${styles.badge} ${BADGE_TONE_CLASS[tone]}`}>{children}</span>;
}
export function VprSearch({ value, onChange, placeholder, ariaLabel }: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel?: string;
}): JSX.Element {
  return (
    <label className={styles.search}>
      <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={2} className={styles.searchIcon} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

/** A titled block of a page: the design's section heading with its caption. */
export function VprSection({ title, caption, action, children }: {
  title: string;
  caption?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionHeadText}>
          <h2 className={styles.sectionTitle}>{title}</h2>
          {caption ? <p className={styles.sectionCaption}>{caption}</p> : null}
        </div>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

export function VprCard({ children, className }: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={`${styles.card}${className ? ` ${className}` : ''}`}>{children}</div>;
}

/** Label + caption + hint on the left, a control (toggle, value) on the right. */
export function VprSettingRow({ title, caption, hint, control }: {
  title: string;
  caption?: string;
  hint?: string;
  control: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.settingRow}>
      <div className={styles.settingText}>
        <div className={styles.settingTitle}>
          <span>{title}</span>
          {caption ? <span className={styles.settingCaption}>{caption}</span> : null}
        </div>
        {hint ? <div className={styles.settingHint}>{hint}</div> : null}
      </div>
      <div className={styles.settingControl}>{control}</div>
    </div>
  );
}
