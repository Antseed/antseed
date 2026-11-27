import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {useLocation} from '@docusaurus/router';
import {useNavbarMobileSidebar} from '@docusaurus/theme-common/internal';
import NavbarMobileSidebar from '@theme/Navbar/MobileSidebar';
import SearchBar from '@theme/SearchBar';
import ThemeSwitch from '@site/src/parts/ThemeSwitch';
import Logo from './Logo';
import NavLink from './NavLink';
import ProvidersMenu from './ProvidersMenu';
import PhoneMenu, {MenuButton, PHONE_MENU_ID} from './PhoneMenu';
import {GatewayCta} from './NavCta';
import {SOCIAL_LINKS} from '../Footer/links';
import {DOCS, ECOSYSTEM, LIVE_PRICES, NETWORK, isDocsRoute} from './links';
import {usePhoneMenu} from './usePhoneMenu';
import styles from './Navbar.module.css';

/**
 * The site nav on every page. Doc-like pages keep it on screen and add the docs search; on the homepage it sits inside the hero's
 * 16px frame. Under 1080px a burger replaces the links: it opens the phone menu, or on a page with a doc or blog tree Docusaurus' mobile
 * sidebar (the tree, with the site links behind "Back to main menu"), which renders beside the nav under the wrapper carrying its state.
 */
export default function Navbar(): JSX.Element {
  const {pathname} = useLocation();
  const docs = isDocsRoute(pathname);
  const sidebar = useNavbarMobileSidebar();
  const nav = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const menu = usePhoneMenu({nav, button: menuButton, sheet});

  return (
    <div
      className={clsx(
        styles.frame,
        docs && styles.sticky,
        pathname === '/' && styles.home,
        !docs && pathname !== '/' && styles.page,
        // Infima shows the mobile sidebar under an ancestor with this class
        sidebar.shown && 'navbar-sidebar--show',
      )}>
      {/* "navbar": Docusaurus' TOC highlighting reads this element's height */}
      <nav ref={nav} aria-label="Main" className={clsx('navbar', styles.nav)} data-analytics-section="nav">
        <Logo />
        <div className={styles.links}>
          <NavLink item={NETWORK} className={styles.link} />
          <ProvidersMenu />
          <NavLink item={ECOSYSTEM} className={styles.link} />
          <NavLink item={LIVE_PRICES} className={styles.link} arrow />
          <NavLink item={DOCS} className={styles.link} />
        </div>
        <div className={styles.actions}>
          {/* mounted everywhere so ⌘K works on every page; the button only shows on doc-like pages */}
          <div className={clsx(styles.search, !docs && styles.searchHidden)}>
            <SearchBar />
          </div>
          {SOCIAL_LINKS.filter(({href}) => /^https:\/\/(github\.com|x\.com|t\.me)\//.test(href)).map(({label, href, viewBox, path}) => (
            <a key={href} href={href} aria-label={label} title={label} className={clsx(styles.link, styles.social)} target="_blank" rel="noopener noreferrer">
              <svg width="18" height="18" viewBox={viewBox} fill="currentColor" aria-hidden="true"><path d={path} /></svg>
            </a>
          ))}
          <ThemeSwitch className={styles.themeSwitch} />
          <GatewayCta className={styles.barGateway} />
          <MenuButton
            buttonRef={menuButton}
            open={menu.expanded}
            controls={menu.usesSidebar ? undefined : PHONE_MENU_ID}
            onToggle={menu.toggle}
          />
        </div>
      </nav>
      {/* outside the nav: its backdrop filter would hold a fixed sheet inside it */}
      <PhoneMenu phase={menu.phase} sheetRef={sheet} onNavigate={menu.close} />
      {sidebar.shouldRender && <div role="presentation" className="navbar-sidebar__backdrop" onClick={sidebar.toggle} />}
      <NavbarMobileSidebar />
    </div>
  );
}
