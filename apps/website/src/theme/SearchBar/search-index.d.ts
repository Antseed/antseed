// Written by plugins/docs-search.ts at build and dev-server start.
declare module '@generated/docs-search/default/search-index.json' {
  import type {SearchEntry} from '@site/plugins/docs-search';
  const entries: SearchEntry[];
  export default entries;
}
