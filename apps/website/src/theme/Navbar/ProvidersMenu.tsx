import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import NavLink from './NavLink';
import {PROVIDERS} from './links';
import {useHoverMenu} from './useHoverMenu';
import styles from './ProvidersMenu.module.css';

const MENU_ID = 'nav-providers';

export default function ProvidersMenu({className}: {className?: string}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const {open, close, rootProps, triggerProps} = useHoverMenu(root, trigger, menu);

  return (
    <div ref={root} className={clsx(styles.root, className)} {...rootProps}>
      <button ref={trigger} type="button" className={styles.trigger} aria-controls={MENU_ID} {...triggerProps}>
        Providers
        <svg className={clsx(styles.chevron, open && styles.chevronOpen)} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      <div ref={menu} id={MENU_ID} className={styles.menu} hidden={!open}>
        {PROVIDERS.map((item) => (
          <NavLink key={item.href} item={item} className={styles.row} onClick={close}>
            <span className={styles.rowTitle}>{item.label}</span>
            <span className={styles.rowText}>{item.description}</span>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
