import { useContext } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import { useUiSelector } from '../../hooks/useUiSelector';
import { VprNavContext, useVprNavBack } from './VprNavContext';
import { VprHeaderActions } from './VprHeaderActions';
import type { ViewName } from '../../types';
import styles from './VprKit.module.scss';

/**
 * Shared brand-guideline primitives for the AI VPN screens (Figma: Toggle -
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
export function VprPage({ title, onBack, backFallback, header, children }: {
  title: string;
  /** Explicit back handler (in-view stages); omit to pop the nav history. */
  onBack?: () => void;
  /** History-empty fallback when onBack is omitted; defaults to 'home'. */
  backFallback?: ViewName;
  /** Extra rows pinned with the header (e.g. search, tabs). */
  header?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const nav = useContext(VprNavContext);
  const credits = useUiSelector((state) => state.creditsTotalOwnedUsdc);
  return (
    <>
      <div className={styles.pageTop}>
        <div className={styles.pageTopInner}>
          <div className={styles.pageHeaderRow}>
            <VprBackTitle title={title} onBack={onBack} fallback={backFallback} />
            <VprHeaderActions credits={credits} onSelectView={nav?.navigate} />
          </div>
          {header}
        </div>
      </div>
      <div className={styles.pageBody} data-view-scroll>
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

export function VprSlider({ min, max, step, value, onChange, ariaLabel }: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  ariaLabel: string;
}): JSX.Element {
  const clamped = Math.min(max, Math.max(min, value));
  const pct = max > min ? ((clamped - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className={styles.slider}
      min={min}
      max={max}
      step={step}
      value={clamped}
      style={{ '--slider-fill': `${pct}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      aria-label={ariaLabel}
    />
  );
}

export function VprStatRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.statRow}>{children}</div>;
}

export function VprStatTile({ label, value, suffix, tone, strong, outlined }: {
  label: string;
  value: ReactNode;
  suffix?: string;
  /** 'success' renders the value in the accent green (Figma price/saving tiles). */
  tone?: 'success';
  /** Bold value (Figma "Saving" tile). */
  strong?: boolean;
  /** Bordered 12px-radius tile variant (Figma "Default model" tiles). */
  outlined?: boolean;
}): JSX.Element {
  const valueClass = [
    styles.statValue,
    tone === 'success' ? styles.statValueSuccess : '',
    strong ? styles.statValueStrong : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={`${styles.statTile}${outlined ? ` ${styles.statTileOutlined}` : ''}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={valueClass}>
        <span className={styles.statValueText}>{value}</span>
        {/* Real space: gives the browser a wrap point before the unit. */}
        {suffix ? <> <span className={styles.statSuffix}>{suffix}</span></> : null}
      </span>
    </div>
  );
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
