import type {JSX, ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import CtaBand, {type CtaBandProps} from '../parts/CtaBand/CtaBand';
import styles from './SitePage.module.css';

type Props = {
  /** The page's name; the document title reads "<title> | Antseed". */
  title: string;
  /** Use `title` as the whole document title, without the site suffix (the homepage). */
  fullTitle?: boolean;
  description: string;
  /** Extra <head> tags: JSON-LD, preloads. */
  head?: ReactNode;
  /** Rendered above the dotted page (the homepage hero). */
  hero?: ReactNode;
  /** The call-to-action band above the footer. */
  cta?: boolean;
  /** Options for the call-to-action band. */
  ctaProps?: CtaBandProps;
  className?: string;
  children: ReactNode;
};

/** A marketing page: site layout (nav, footer), the dotted content area, and the CTA band (reveal-on-scroll is document-wide, see useDocumentReveal). */
export function SitePage({title, fullTitle, description, head, hero, cta = true, ctaProps, className, children}: Props): JSX.Element {
  return (
    <Layout title={fullTitle ? undefined : title} description={description}>
      {fullTitle && (
        <Head>
          <title>{title}</title>
          <meta property="og:title" content={title} />
        </Head>
      )}
      {head && <Head>{head}</Head>}
      <main className={styles.main}>
        {hero}
        <div className={clsx(styles.page, className)}>
          {children}
          {cta && <CtaBand {...ctaProps} />}
        </div>
      </main>
    </Layout>
  );
}
