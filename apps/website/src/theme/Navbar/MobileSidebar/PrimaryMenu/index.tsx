import type {JSX} from 'react';
import {useNavbarMobileSidebar} from '@docusaurus/theme-common/internal';
import {PhoneMenuLinks} from '../../PhoneMenu';
import styles from './PrimaryMenu.module.css';

/** The docs sidebar's main menu (behind "Back to main menu"): the same links, in the same look, as the phone menu on other pages. */
export default function NavbarMobilePrimaryMenu(): JSX.Element {
  const {toggle} = useNavbarMobileSidebar();
  return <PhoneMenuLinks onNavigate={toggle} className={styles.links} />;
}
