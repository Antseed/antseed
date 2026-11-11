/**
 * File, JSONC and saved-selection helpers shared by the config-patch writers
 * (config-patch.ts and the per-tool modules under config-patch/). Internal to
 * this package; config-patch.ts re-exports the few that are public.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ResolvedTarget } from './config-patch.js';

/**
 * Model alias resolved by the buyer proxy at request time to the route
 * currently selected in Antseed Desktop. Must match
 * ROUTED_MODEL_ALIAS in apps/cli/src/proxy/request-utils.ts.
 */
export const ROUTED_MODEL_ALIAS = 'antseed';

export type JsonObject = Record<string, unknown>;

/**
 * The model a (re)patch should select: the tool's current selection when it
 * is still one of the target's models (the user picked it in the tool),
 * otherwise the target default. Undefined when the target serves no models,
 * in which case the selection is left alone.
 */
export function pickModel(target: ResolvedTarget, current: unknown): string | undefined {
  if (typeof current === 'string' && target.modelIds.includes(current)) return current;
  return target.defaultModel ?? target.models[0]?.id;
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
