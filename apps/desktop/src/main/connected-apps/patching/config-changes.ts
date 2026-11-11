/**
 * When each connected app's config last changed. A running app keeps the
 * config it read at launch, so it needs a restart only when its own config
 * changed after it started: a re-apply that writes what the config already
 * says (a privacy switch that leaves the app's models as they were) or one
 * that failed before writing changes nothing.
 */
import { createHash } from 'node:crypto';
import type { ConfigPatchTarget } from '@antseed/connected-apps/config-patch';

/** The fields that make up an app's model list; the rest is its connection (gateway, key). */
const MODEL_LIST_FIELDS = new Set(['models', 'unlistedModels', 'defaultModel', 'modelsLoaded']);

/**
 * A hash of part of what a patch writes (it holds the API key), ignoring
 * order: the gateway's listing order isn't stable, and a reordered model list
 * is the same list to an app.
 */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    const byId = items.every((item) => typeof (item as { id?: unknown } | null)?.id === 'string');
    return byId ? items.sort((left, right) => (left as { id: string }).id.localeCompare((right as { id: string }).id)) : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** What a patch writes, as the connection's and the model list's fingerprints. */
export function configPatchFingerprint(target: ConfigPatchTarget): { connection: string; models: string } {
  const fields = Object.entries(target as Record<string, unknown>);
  return {
    connection: fingerprint(Object.fromEntries(fields.filter(([key]) => !MODEL_LIST_FIELDS.has(key)))),
    models: fingerprint(Object.fromEntries(fields.filter(([key]) => MODEL_LIST_FIELDS.has(key) && key !== 'modelsLoaded'))),
  };
}

export type ConfigChangeLog = {
  /** Records a successful write of `target` to the app's config; true when it differs from the last one. */
  recordWrite: (name: string, target: ConfigPatchTarget) => boolean;
  /** The app's config is no longer Antseed's (disconnected): its next write is a change. */
  forget: (name: string) => void;
  /** App name → when its config last changed, for apps written since the desktop started. */
  changedAt: () => Record<string, number>;
};

export function createConfigChangeLog(now: () => number = Date.now): ConfigChangeLog {
  const written = new Map<string, { connection: string; models: string }>();
  const changed = new Map<string, number>();
  return {
    recordWrite(name, target) {
      const next = configPatchFingerprint(target);
      const last = written.get(name);
      // A model list the gateway couldn't return leaves the app's list as it was.
      const unread = target.modelsLoaded === false || (target.modelsLoaded === undefined && target.models.length === 0);
      if (last && unread) next.models = last.models;
      if (last && last.connection === next.connection && last.models === next.models) return false;
      written.set(name, next);
      changed.set(name, now());
      return true;
    },
    forget(name) {
      written.delete(name);
      changed.delete(name);
    },
    changedAt: () => Object.fromEntries(changed),
  };
}

/**
 * Whether a running app must restart to read its config: one the desktop
 * didn't start (or that was restarted outside it) can't be told apart from
 * one started before the change, and one it started needs a restart only when
 * its config changed after the launch (`configChangedAt`, null when Antseed
 * hasn't changed it since the desktop started).
 */
export function runningAppNeedsRestart(
  processInfo: { running: boolean; pid?: number; startedAt?: number },
  managed: { launchedAt: number; pid?: number; startedAt?: number } | undefined,
  configChangedAt: number | null,
): boolean {
  if (!processInfo.running) return false;
  if (!managed) return true;
  if (managed.pid && processInfo.pid && managed.pid !== processInfo.pid) return true;
  if (managed.startedAt && processInfo.startedAt && Math.abs(managed.startedAt - processInfo.startedAt) > 2_000) return true;
  if (!managed.pid && processInfo.startedAt && processInfo.startedAt > managed.launchedAt + 2_000) return true;
  return configChangedAt !== null && managed.launchedAt < configChangedAt;
}
