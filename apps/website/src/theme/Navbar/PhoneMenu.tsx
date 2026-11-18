import type {CSSProperties, JSX, Ref} from 'react';
import clsx from 'clsx';
import {DownloadCta, GatewayCta} from './NavCta';
import NavLink from './NavLink';
import {MENU_TAIL, NETWORK, PROVIDERS, PROVIDERS_PAGE} from './links';
import type {SheetPhase} from './usePhoneMenu';
import styles from './PhoneMenu.module.css';

export const PHONE_MENU_ID = 'site-menu';

/** Each row's place in the unrolling entrance. */
const order = (i: number) => ({'--i': i}) as CSSProperties;

type Props = {
  phase: SheetPhase;
  sheetRef: Ref<HTMLDivElement>;
  onNavigate: () => void;
};

/**
 * The sheet under the nav where the bar's links don't fit: the links at one size, Providers' two pages under it, and on a tablet the
 * nav's two buttons at its foot.
 */
export default function PhoneMenu({phase, sheetRef, onNavigate}: Props): JSX.Element {
  const row = (i: number) => ({className: styles.row, style: order(i), onClick: onNavigate});
  return (
    <div ref={sheetRef} id={PHONE_MENU_ID} className={clsx(styles.sheet, phase === 'closing' && styles.closing)} hidden={phase === 'closed'}>
      <div className={styles.links}>
        <NavLink item={NETWORK} {...row(0)} />
        <NavLink item={PROVIDERS_PAGE} {...row(1)} />
        <div className={styles.sub}>
          {PROVIDERS.map((item, i) => (
            <NavLink key={item.href} item={item} className={styles.subRow} style={order(2 + i)} onClick={onNavigate}>
              <b className={styles.subTitle}>{item.label}</b>
              <span className={styles.subText}>{item.shortDescription}</span>
            </NavLink>
          ))}
        </div>
        {MENU_TAIL.map((item, i) => (
          <NavLink key={item.href} item={item} arrow {...row(2 + PROVIDERS.length + i)} />
        ))}
      </div>
      <div className={styles.actions}>
        <DownloadCta className={styles.action} />
        <GatewayCta className={styles.action} />
      </div>
    </div>
  );
}

type ButtonProps = {open: boolean; controls?: string; onToggle: () => void; buttonRef: Ref<HTMLButtonElement>};

/** The burger where the bar's links were; a cross while the menu is open. */
export function MenuButton({open, controls, onToggle, buttonRef}: ButtonProps): JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.button}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? 'Close menu' : 'Menu'}
      onClick={onToggle}>
      <MenuIcon open={open} />
    </button>
  );
}

/** Three lines, or a cross while open, at the footer icons' stroke. */
export function MenuIcon({open}: {open: boolean}): JSX.Element {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
      {open ? <path d="M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5" /> : <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />}
    </svg>
  );
}
