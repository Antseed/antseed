import type {JSX} from 'react';
import Meadow from '@site/src/parts/Meadow/Meadow';
import FooterNav from './FooterNav';
import SocialLinks from './SocialLinks';
import ThemeChoice from './ThemeChoice';
import styles from './Footer.module.css';

/** Fixed when the site is built, so the server HTML and the client agree. */
const YEAR = new Date().getFullYear();

/** The site footer on every page (marketing, docs, blog): links over the painted meadow. */
export default function Footer(): JSX.Element {
  return (
    <footer className={styles.footer} data-cmp="site/footer">
      <Meadow />
      <div className={styles.rail}>
        <FooterNav />
        <div className={styles.bar}>
          <span className={styles.copyright}>© {YEAR} Antseed Foundation</span>
          <SocialLinks />
          <ThemeChoice />
        </div>
      </div>
    </footer>
  );
}
