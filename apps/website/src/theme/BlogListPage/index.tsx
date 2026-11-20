/**
 * BlogListPage, ejected from theme-classic: the blog index as a site page (the section head, the BlogPostItems card grid, the
 * paginator). Search metadata and structured data are kept from the original.
 */
import type {ReactNode} from 'react';
import clsx from 'clsx';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {HtmlClassNameProvider, ThemeClassNames} from '@docusaurus/theme-common';
import BlogListPaginator from '@theme/BlogListPaginator';
import SearchMetadata from '@theme/SearchMetadata';
import type {Props} from '@theme/BlogListPage';
import BlogPostItems from '@theme/BlogPostItems';
import BlogListPageStructuredData from '@theme/BlogListPage/StructuredData';
import {Section, SectionHead, SitePage} from '@site/src/components';
import styles from './styles.module.css';

export default function BlogListPage(props: Props): ReactNode {
  const {metadata, items} = props;
  const {siteConfig} = useDocusaurusContext();
  const title = metadata.permalink === '/' ? siteConfig.title : metadata.blogTitle;
  return (
    <HtmlClassNameProvider className={clsx(ThemeClassNames.wrapper.blogPages, ThemeClassNames.page.blogListPage)}>
      <SearchMetadata tag="blog_posts_list" />
      <BlogListPageStructuredData {...props} />
      <SitePage title={title} description={metadata.blogDescription}>
        <Section cmp="blog/list" labelledBy="blog-title" pad="all">
          <SectionHead lead eyebrow="Blog" id="blog-title" title={metadata.blogTitle} sub={metadata.blogDescription} />
          <div className={styles.grid}>
            <BlogPostItems items={items} />
          </div>
          <div className={styles.paginator}>
            <BlogListPaginator metadata={metadata} />
          </div>
        </Section>
      </SitePage>
    </HtmlClassNameProvider>
  );
}
