/**
 * Writes the Colony share pages (/colony/mac/<slug>/index.html, one per Mac the sign-up offers) into the build from one template
 * (src/sections/colony/join/sharePages.ts), so their tags and redirect live in one place.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type {Plugin} from '@docusaurus/types';
import {sharePages} from '../src/sections/colony/join/sharePages';

export default function colonySharePagesPlugin(): Plugin {
  return {
    name: 'colony-share-pages',
    async postBuild({outDir}) {
      await Promise.all(sharePages().map(async ({path: page, html}) => {
        const dir = path.join(outDir, page);
        await fs.mkdir(dir, {recursive: true});
        await fs.writeFile(path.join(dir, 'index.html'), html);
      }));
    },
  };
}
