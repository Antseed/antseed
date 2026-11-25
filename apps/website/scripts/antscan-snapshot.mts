// Refreshes src/data/antscan-fallback.json: the snapshot the build falls back to when Antscan can't be read
// (plugins/antscan-snapshot.ts). Run it on purpose, never from a build: pnpm --filter @antseed/website antscan:snapshot
import fs from 'node:fs/promises';
import {LOADERS} from '../src/lib/antscan/client.ts';
import type {AntscanSnapshot, ResourceKey} from '../src/lib/antscan/types.ts';

const FILE = new URL('../src/data/antscan-fallback.json', import.meta.url);
const keys = Object.keys(LOADERS) as ResourceKey[];
const values = await Promise.all(keys.map((key) => LOADERS[key](AbortSignal.timeout(20_000))));
const snapshot = {readAt: new Date().toISOString(), ...Object.fromEntries(keys.map((key, i) => [key, values[i]]))} as AntscanSnapshot;
await fs.writeFile(FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`antscan-fallback.json read at ${snapshot.readAt}`);
