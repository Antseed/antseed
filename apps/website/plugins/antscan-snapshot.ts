/**
 * Reads the network figures and the price board from Antscan at build time and hands them to the pages as global data
 * (`usePluginData('antscan-snapshot')`), so the server HTML carries real numbers; the hooks in src/lib/antscan refresh them
 * in the browser after mount.
 *
 * When a read fails, that resource comes from the committed src/data/antscan-fallback.json and the build goes on with a
 * warning. The file is generated, never edited by hand, and only rewritten on purpose (`pnpm --filter @antseed/website
 * antscan:snapshot`, scripts/antscan-snapshot.mts), so builds leave no diff.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type {LoadContext, Plugin} from '@docusaurus/types';
import {LOADERS} from '../src/lib/antscan/client';
import type {AntscanResources, AntscanSnapshot, ResourceKey} from '../src/lib/antscan/types';

const NAME = 'antscan-snapshot';
const TIMEOUT_MS = 20_000;
const KEYS = Object.keys(LOADERS) as ResourceKey[];

async function readFallback(file: string): Promise<AntscanSnapshot> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as AntscanSnapshot;
}

async function load<K extends ResourceKey>(key: K): Promise<AntscanResources[K] | null> {
  try {
    return await LOADERS[key](AbortSignal.timeout(TIMEOUT_MS));
  } catch (error) {
    console.warn(`[${NAME}] ${key}: ${(error as Error).message}; using the committed fallback`);
    return null;
  }
}

export default function antscanSnapshotPlugin(context: LoadContext): Plugin<AntscanSnapshot> {
  const fallbackFile = path.join(context.siteDir, 'src/data/antscan-fallback.json');
  return {
    name: NAME,
    async loadContent() {
      const live = await Promise.all(KEYS.map((key) => load(key)));
      if (live.every((value) => value !== null)) {
        return {readAt: new Date().toISOString(), ...Object.fromEntries(KEYS.map((key, i) => [key, live[i]]))} as AntscanSnapshot;
      }
      const fallback = await readFallback(fallbackFile);
      return {...fallback, ...Object.fromEntries(KEYS.flatMap((key, i) => (live[i] === null ? [] : [[key, live[i]]])))};
    },
    async contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },
  };
}
