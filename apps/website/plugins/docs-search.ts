/**
 * Docusaurus plugin that builds the docs search index.
 *
 * Every docs page becomes one entry for the page itself and one per `##` /
 * `###` section, with the section's anchor so a result jumps straight to it.
 * Each entry carries its sidebar category, which the search modal shows as a
 * badge. The index is written with createData, and src/theme/SearchBar loads
 * it lazily from @generated/docs-search/default/search-index.json the first
 * time the modal opens, so it works under `docusaurus start` as well as in a
 * build, with no external service.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import GithubSlugger from 'github-slugger';
import type {LoadContext, Plugin} from '@docusaurus/types';

export type SearchEntry = {
  /** Page title. */
  page: string;
  /** Section heading; empty for the page entry itself. */
  heading: string;
  /** Sidebar category label, e.g. "Gateway Console". */
  category: string;
  /** Page description (page entries) or the section's opening text. */
  summary: string;
  /** Plain text searched but not shown. */
  text: string;
  url: string;
};

type LoadedDoc = {
  id: string;
  title: string;
  description: string;
  permalink: string;
  source: string;
  unlisted?: boolean;
};

type SidebarItem = {type: string; label?: string; id?: string; items?: SidebarItem[]};

// Strips Markdown down to the text a reader sees.
function toPlainText(md: string): string {
  return md
    .replace(/^```.*$/gm, '')
    .replace(/^:::.*$/gm, '')
    .replace(/^(import|export) .*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/[|*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The heading text Docusaurus slugs to build the anchor id.
function headingText(md: string): string {
  return md
    .replace(/\s*\{#[^}]+\}\s*$/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}

function excerpt(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`;
}

function docEntries(doc: LoadedDoc, body: string, category: string): SearchEntry[] {
  const slugger = new GithubSlugger();
  const page = doc.title;
  const sections: {heading: string; anchor: string; lines: string[]}[] = [
    {heading: '', anchor: '', lines: []},
  ];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (match && match[1].length === 1) continue; // the page title
    if (match) {
      const raw = match[2];
      const explicit = /\{#([^}]+)\}\s*$/.exec(raw);
      const text = headingText(raw);
      const anchor = explicit ? explicit[1] : slugger.slug(text);
      if (match[1].length <= 3) {
        sections.push({heading: text, anchor, lines: []});
        continue;
      }
    }
    sections[sections.length - 1].lines.push(line);
  }

  return sections.map(({heading, anchor, lines}) => {
    const text = toPlainText(lines.join('\n'));
    return {
      page,
      heading,
      category,
      summary: heading ? excerpt(text) : doc.description || excerpt(text),
      text,
      url: anchor ? `${doc.permalink}#${anchor}` : doc.permalink,
    };
  });
}

export default function docsSearchPlugin(context: LoadContext): Plugin {
  return {
    name: 'docs-search',

    async allContentLoaded({allContent, actions}) {
      const docsContent = allContent['docusaurus-plugin-content-docs']?.default as
        | {loadedVersions: {docs: LoadedDoc[]; sidebars: Record<string, SidebarItem[]>}[]}
        | undefined;
      const version = docsContent?.loadedVersions[0];
      if (!version) return;

      // Map each doc id to the top-level sidebar category that holds it.
      const categoryOf = new Map<string, string>();
      const walk = (items: SidebarItem[], label: string) => {
        for (const item of items) {
          if (item.type === 'doc' && item.id) categoryOf.set(item.id, label);
          if (item.items) walk(item.items, label);
        }
      };
      for (const sidebar of Object.values(version.sidebars)) {
        for (const item of sidebar) {
          if (item.type === 'category' && item.items) walk(item.items, item.label ?? '');
        }
      }

      const entries: SearchEntry[] = [];
      for (const doc of version.docs) {
        if (doc.unlisted) continue;
        const file = path.join(context.siteDir, doc.source.replace(/^@site\//, ''));
        const raw = await fs.readFile(file, 'utf8');
        const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
        entries.push(...docEntries(doc, body, categoryOf.get(doc.id) ?? 'Docs'));
      }

      await actions.createData('search-index.json', JSON.stringify(entries));
    },
  };
}
