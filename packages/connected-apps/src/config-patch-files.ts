/**
 * File, JSONC and saved-selection helpers shared by the config-patch writers
 * (config-patch.ts and the per-tool modules under config-patch/). Internal to
 * this package; config-patch.ts re-exports the few that are public.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { sameCanonicalModel } from '@antseed/node/model-identity';
import type { ResolvedTarget } from './config-patch.js';

/**
 * Model alias resolved by the buyer proxy at request time to the buyer's
 * default route (set through its `/_antseed/route` API). Legacy buyer-port
 * patches select it; gateway patches list the gateway's models instead. Must
 * match ROUTED_MODEL_ALIAS in apps/cli/src/proxy/request-utils.ts.
 */
export const ROUTED_MODEL_ALIAS = 'antseed';

export type JsonObject = Record<string, unknown>;

/** A gateway model as a connected app lists it. */
export type ConfigPatchModel = {
  readonly id: string;
  readonly label?: string;
  /** A seller reports reasoning support: the app's picker offers effort levels for it. */
  readonly reasoning?: boolean;
};

/** Effort levels offered for a reasoning model, where an app lets its config name them. */
export const CONNECTED_APP_REASONING_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh'];
export const CONNECTED_APP_DEFAULT_REASONING = 'medium';

/** What one tool config lists, and the model it selects. */
export type ModelPick = {
  /** The target's models, plus the tool's selection when the gateway serves it without listing it. */
  readonly models: ReadonlyArray<ConfigPatchModel>;
  readonly modelIds: readonly string[];
  /** Undefined when the target serves no models: the selection is left alone. */
  readonly selected: string | undefined;
};

/**
 * The model in `models` that `id` names: its own id, else (ignoring case) its
 * id, else the same model by the buyer's canonical rule (the `/v1/models`
 * entry can name it `glm-5` one read and `z-ai/glm-5` the next).
 */
function findModel(models: ReadonlyArray<ConfigPatchModel>, id: string): ConfigPatchModel | undefined {
  const exact = models.find((model) => model.id === id);
  if (exact) return exact;
  const key = id.toLowerCase();
  return models.find((model) => model.id.toLowerCase() === key)
    ?? models.find((model) => sameCanonicalModel(id, model.id));
}

/**
 * The models a (re)patch writes into one tool config, and the model each of
 * the tool's selections (`currents`) should be. A selection the user made in
 * the tool is kept while the gateway still serves that model: under the id
 * the target lists it by (a selection of an alias moves to it), or, for a
 * model the target leaves out (`unlistedModels`), listed beside the target's
 * so the tool still offers it. Any other selection becomes the target
 * default; undefined when the target serves no models, in which case the
 * selection is left alone.
 */
export function pickModels(target: ResolvedTarget, currents: readonly unknown[]): { models: ReadonlyArray<ConfigPatchModel>; modelIds: readonly string[]; selected: Array<string | undefined> } {
  const kept: ConfigPatchModel[] = [];
  const fallback = target.defaultModel ?? target.models[0]?.id;
  const selected = currents.map((current) => {
    if (typeof current !== 'string' || current.length === 0) return fallback;
    const listed = findModel(target.models, current) ?? findModel(kept, current);
    if (listed) return listed.id;
    const unlisted = findModel(target.unlistedModels, current);
    if (!unlisted) return fallback;
    kept.push(unlisted);
    return unlisted.id;
  });
  const models = kept.length > 0 ? [...target.models, ...kept] : target.models;
  return { models, modelIds: models.map((model) => model.id), selected };
}

/** `pickModels` for a tool with one selection. */
export function pickModel(target: ResolvedTarget, current: unknown): ModelPick {
  const { models, modelIds, selected } = pickModels(target, [current]);
  return { models, modelIds, selected: selected[0] };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

export function stripJsoncComments(raw: string): string {
  let result = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) result += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        result += raw[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i++;
      continue;
    }
    result += ch;
  }
  return result;
}

export function stripJsoncTrailingCommas(raw: string): string {
  let result = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === '}' || raw[j] === ']') {
        continue;
      }
    }
    result += ch;
  }
  return result;
}

export function parseJsoncObject(raw: string, filePath: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(raw)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to parse JSONC config at ${filePath}: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSONC config at ${filePath} must be an object`);
  }
  return parsed as JsonObject;
}

export function readJsoncFile(filePath: string): JsonObject | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return parseJsoncObject(raw, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function tryReadConfigPatchFile(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return readJsoncFile(filePath);
}

export function writeJsonFile(filePath: string, data: JsonObject): void {
  writeTextFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function restrictToOwner(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems (a WSL share, say) have no such permissions to set.
  }
}

/**
 * These files hold a real gateway key, so only their owner may read them. The
 * mode only applies to a new file, so one that already exists is tightened too.
 */
export function writePrivateFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  restrictToOwner(filePath);
}

/**
 * Copies the user's config aside once, before Antseed first changes it. A
 * config Antseed creates has no original, so that is recorded instead: a later
 * refresh or disconnect would otherwise back up Antseed's own config, gateway
 * key included, as if it were the user's.
 */
export function backupConfigFile(filePath: string): void {
  const backupPath = `${filePath}.antseed.bak`;
  const absentPath = `${filePath}.antseed.absent`;
  if (existsSync(backupPath) || existsSync(absentPath)) return;
  if (!existsSync(filePath)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writePrivateFile(absentPath, '');
    return;
  }
  copyFileSync(filePath, backupPath);
  restrictToOwner(backupPath);
}

/**
 * The model the user had selected before Antseed took over, kept beside the
 * config so disconnecting (and quitting, with a local gateway) gives it back.
 * Written only while the selection isn't ours, so a re-apply never overwrites it.
 */
export function selectionPath(filePath: string): string {
  return `${filePath}.antseed.selection.json`;
}

export function readSelection(filePath: string): JsonObject {
  try {
    return tryReadConfigPatchFile(selectionPath(filePath)) ?? {};
  } catch {
    return {};
  }
}

export function rememberSelection(filePath: string, selection: JsonObject): void {
  if (Object.keys(selection).length > 0) {
    writeJsonFile(selectionPath(filePath), selection);
  } else {
    rmSync(selectionPath(filePath), { force: true });
  }
}

/**
 * Drops the saved selection once the restored config is written. A disconnect
 * reads it first and forgets it last, so a failed write keeps it for a retry.
 */
export function forgetSelection(filePath: string): void {
  rmSync(selectionPath(filePath), { force: true });
}

export function writeTextFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writePrivateFile(filePath, content);
}

// --- Droid CLI + Factory Desktop (`~/.factory/settings.json`) ---
//
// Both clients watch this file and share its `customModels` catalog. The
// sidecar remembers only the fields Antseed temporarily owns so disconnect
// can restore the user's prior default without rolling back unrelated edits.
