import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readStringArray } from './profiles.js';

/**
 * Apps only the desktop stopped connecting are cleaned up once, after the
 * update. Which ones still need it is kept apart from connected-apps.json, and
 * an app leaves the list only once its config no longer points at Antseed, so
 * a cleanup that failed (a config that couldn't be written) is retried at the
 * next launch instead of being forgotten.
 */
export type RetiredMigrationStore = {
  /** Null before the first launch after the update. */
  read: () => string[] | null;
  write: (pending: string[]) => void;
};

export function retiredMigrationStore(file: string): RetiredMigrationStore {
  return {
    read: () => {
      if (!existsSync(file)) return null;
      try {
        return readStringArray((JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)['pending']);
      } catch {
        return [];
      }
    },
    write: (pending) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ pending }, null, 2)}\n`);
    },
  };
}

/**
 * Runs the cleanup for the apps still pending (on the first launch, the ones
 * the old desktop had connected) and saves the ones that failed. `cleanUp`
 * throws when an app's config still points at Antseed afterwards.
 */
export function migrateRetiredApps(opts: {
  store: RetiredMigrationStore;
  /** Apps the old desktop had connected; read only on the first launch after the update. */
  firstLaunchNames: () => string[];
  cleanUp: (name: string) => void;
}): string[] {
  const pending = opts.store.read() ?? opts.firstLaunchNames();
  const failed = pending.filter((name) => {
    try {
      opts.cleanUp(name);
      return false;
    } catch {
      return true;
    }
  });
  opts.store.write(failed);
  return failed;
}

