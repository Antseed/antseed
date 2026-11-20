import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {FOOTER_COLUMNS, type FooterLink} from './links';
import styles from './Footer.module.css';

function ColumnLink({link}: {link: FooterLink}): JSX.Element {
  return link.external
    ? <a className={styles.link} href={link.to} target="_blank" rel="noopener noreferrer">{link.label}</a>
    : <Link className={styles.link} to={link.to}>{link.label}</Link>;
}

/** The logo and the link columns. */
export default function FooterNav(): JSX.Element {
  return (
    <nav className={styles.columns} aria-label="Footer">
      <Link className={styles.brand} to="/" aria-label="Antseed">
        <img className={styles.logo} src="/site/assets/hero/logo.svg" width={95.3464} height={33} alt="Antseed" loading="lazy" />
      </Link>
      {FOOTER_COLUMNS.map((column) => (
        <div key={column.title} className={styles.column}>
          <p className={styles.columnTitle}>{column.title}</p>
          {column.links.map((link) => <ColumnLink key={link.label} link={link} />)}
        </div>
      ))}
    </nav>
  );
}
