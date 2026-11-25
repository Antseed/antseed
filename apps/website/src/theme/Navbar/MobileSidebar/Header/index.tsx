import type {JSX} from 'react';
import {useNavbarMobileSidebar} from '@docusaurus/theme-common/internal';
import ThemeSwitch from '@site/src/parts/ThemeSwitch';
import Logo from '../../Logo';
import {MenuIcon} from '../../PhoneMenu';
import styles from './Header.module.css';

/** The mobile sidebar's top row: the site logo, the day/night switch and the same cross as the nav's burger. */
export default function NavbarMobileSidebarHeader(): JSX.Element {
  const {toggle} = useNavbarMobileSidebar();
  return (
    <div className="navbar-sidebar__brand">
      <Logo onClick={toggle} />
      <div className={styles.end}>
        <ThemeSwitch />
        <button type="button" aria-label="Close navigation bar" className={styles.close} onClick={toggle}>
          <MenuIcon open />
        </button>
      </div>
    </div>
  );
}
