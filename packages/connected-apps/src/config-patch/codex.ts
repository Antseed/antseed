/**
 * Codex CLI (`~/.codex/config.toml`): the provider table, the top-level model
 * selection, the gateway model catalog and their removal. config-patch.ts
 * runs it per install (native and WSL) and dispatches to it.
 *
 * Codex config is TOML, edited structurally instead of parsed: the managed
 * `[model_providers.<key>]` table is replaced wholesale and the top-level
 * `model_provider` / `model` keys are set in the region before the first
 * table header (TOML requires top-level keys there). Everything the user
 * wrote is left untouched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ANTSEED_MODEL_CONTEXT_WINDOW } from '@antseed/protocol/service-api';
import type { CodexConfigPatchDef, ResolvedTarget } from '../config-patch.js';
import {
  buildCodexModelCatalog,
  codexModelCatalogIs,
  codexModelCatalogOwner,
  CODEX_MODEL_CATALOG_FILE,
  removeCodexModelCatalog,
  validateCodexModelCatalog,
  writeCodexModelCatalog,
} from '../codex-model-catalog.js';
import {
  backupConfigFile,
  expandTilde,
  forgetSelection,
  pickModel,
  readSelection,
  rememberSelection,
  writeTextFile,
} from '../config-patch-files.js';

/**
 * A TOML basic string. JSON's escapes are TOML's too, and cover every control
 * character a gateway's model id could carry (a raw newline breaks the file);
 * DEL is the one TOML also forbids that JSON leaves as is.
 */
function tomlBasicString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, '\\u007f');
}

function firstTomlTableIndex(lines: readonly string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

export function isCodexProviderTableHeader(line: string, providerKey: string): boolean {
  const match = line.match(/^\s*\[\s*model_providers\s*\.\s*("?)([^\]"]+)\1\s*\]\s*(#.*)?$/);
  return match?.[2]?.trim() === providerKey;
}

function removeCodexProviderTable(lines: readonly string[], providerKey: string): { lines: string[]; changed: boolean } {
  const start = lines.findIndex((line) => isCodexProviderTableHeader(line, providerKey));
  if (start === -1) return { lines: [...lines], changed: false };
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  return { lines: [...lines.slice(0, start), ...lines.slice(end)], changed: true };
}

function tomlTopLevelKeyIndex(lines: readonly string[], key: string): number {
  const limit = firstTomlTableIndex(lines);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < limit; i++) {
    if (pattern.test(lines[i]!)) return i;
  }
  return -1;
}

function setTomlTopLevelValue(lines: readonly string[], key: string, value: string): string[] {
  const assignment = `${key} = ${value}`;
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index !== -1) {
    const next = [...lines];
    next[index] = assignment;
    return next;
  }
  const limit = firstTomlTableIndex(lines);
  return [...lines.slice(0, limit), assignment, ...lines.slice(limit)];
}

function setTomlTopLevelString(lines: readonly string[], key: string, value: string): string[] {
  return setTomlTopLevelValue(lines, key, tomlBasicString(value));
}

export function readTomlTopLevelString(lines: readonly string[], key: string): string | undefined {
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index === -1) return undefined;
  const line = lines[index]!;
  const literal = line.match(/=\s*'([^']*)'\s*(#.*)?$/);
  if (literal) return literal[1]!;
  const match = line.match(/=\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$/);
  if (!match) return undefined;
  return unescapeTomlBasicString(match[1]!);
}

const TOML_SIMPLE_ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' };

/** A TOML basic string's escapes, `\uXXXX` and `\UXXXXXXXX` included (JSON has no eight-digit form). */
export function unescapeTomlBasicString(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (escape, body: string) => {
    if (body.length > 1) {
      const code = Number.parseInt(body.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
    }
    return TOML_SIMPLE_ESCAPES[body] ?? body;
  });
}

function removeTomlTopLevelKey(lines: readonly string[], key: string): string[] {
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index === -1) return [...lines];
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

export function applyCodexProviderToFile(filePath: string, patch: CodexConfigPatchDef, baseURL: string, t: ResolvedTarget): void {
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  // Only a model selected under our provider counts as the user's pick;
  // a model chosen for another provider is replaced along with the provider.
  const ownedSelection = readTomlTopLevelString(lines, 'model_provider') === patch.providerKey
    ? readTomlTopLevelString(lines, 'model')
    : undefined;
  const selected = pickModel(t, ownedSelection);
  if (readTomlTopLevelString(lines, 'model_provider') !== patch.providerKey) {
    const userCatalog = readTomlTopLevelString(lines, 'model_catalog_json');
    // The value as written: TOML also allows forms like 128_000.
    const contextWindow = /=\s*([^\s#]+)/.exec(lines[tomlTopLevelKeyIndex(lines, 'model_context_window')] ?? '')?.[1];
    rememberSelection(filePath, {
      ...Object.fromEntries(['model', 'model_provider'].flatMap((key) => {
        const value = readTomlTopLevelString(lines, key);
        return value === undefined ? [] : [[key, value]];
      })),
      ...(contextWindow ? { model_context_window: contextWindow } : {}),
      ...(userCatalog !== undefined && !isManagedCodexCatalogRef(filePath, userCatalog) ? { model_catalog_json: userCatalog } : {}),
    });
  }
  lines = removeCodexProviderTable(lines, patch.providerKey).lines;
  lines = setTomlTopLevelString(lines, 'model_provider', patch.providerKey);
  if (selected) lines = setTomlTopLevelString(lines, 'model', selected);
  lines = setTomlTopLevelValue(lines, 'model_context_window', String(ANTSEED_MODEL_CONTEXT_WINDOW));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines.push(
    '',
    `[model_providers.${patch.providerKey}]`,
    `name = ${tomlBasicString(patch.providerName)}`,
    `base_url = ${tomlBasicString(baseURL)}`,
    // The only wire API Codex still supports. The legacy keyless buyer proxy
    // gets no credential (no env_key ⇒ no Authorization header); a gateway
    // gets its key as a static bearer token — Codex otherwise only reads keys
    // from an environment variable, which a config patch cannot set.
    'wire_api = "responses"',
    ...(t.legacy ? [] : [`experimental_bearer_token = ${tomlBasicString(t.apiKey)}`]),
  );
  // The legacy proxy serves one alias, so a gateway's model catalog no longer applies.
  if (t.legacy) {
    writeTextFile(filePath, `${withoutManagedCodexCatalog(filePath, lines).join('\n')}\n`);
    removeCodexModelCatalog(filePath);
    return;
  }
  // The model catalog follows in finishConfigPatch: building it runs Codex,
  // which must not block this synchronous write.
  writeTextFile(filePath, `${lines.join('\n')}\n`);
}

/**
 * Codex's half of `finishConfigPatch`: the catalog listing the gateway's
 * models, built and checked by the Codex on this machine. It lands only while
 * the config is still the one `writeConfigPatch` wrote and `isCurrent()`
 * holds, so a newer patch or a disconnect in the meantime wins.
 */
export async function finishCodexConfigPatch(
  patch: CodexConfigPatchDef,
  t: ResolvedTarget,
  { isCurrent = () => true }: { isCurrent?: () => boolean } = {},
): Promise<void> {
  const filePath = expandTilde(patch.configPath);
  // A catalog can only be built by the Codex on this machine, not one inside WSL.
  if (t.legacy || t.models.length === 0 || filePath.startsWith('\\\\')) return;
  let written: string;
  try {
    written = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const lines = written.endsWith('\n') ? written.slice(0, -1).split('\n') : written.split('\n');
  // Only a config this patch points at the gateway (Codex may live only in WSL).
  if (readTomlTopLevelString(lines, 'model_provider') !== patch.providerKey) return;
  const fileIs = (expected: string) => {
    try {
      return readFileSync(filePath, 'utf8') === expected;
    } catch {
      return false;
    }
  };
  const catalog = await buildCodexModelCatalog(filePath, t.models);
  // A catalog of the user's under our file name is never overwritten.
  if (!catalog || !isCurrent() || !fileIs(written) || !writeCodexModelCatalog(filePath, catalog)) return;
  const withCatalog = `${setTomlTopLevelString(lines, 'model_catalog_json', CODEX_MODEL_CATALOG_FILE).join('\n')}\n`;
  writeTextFile(filePath, withCatalog);
  // Codex refuses to start on a catalog it can't parse, so never leave one behind.
  try {
    await validateCodexModelCatalog(filePath);
  } catch {
    // A newer refresh wrote its own catalog since: that one is left to its own check.
    if (!codexModelCatalogIs(filePath, catalog)) return;
    // Even when superseded or edited meanwhile: a config still naming the
    // rejected catalog would stop Codex starting. Only our reference goes;
    // whatever else changed in the config stays.
    let current: string | null = null;
    try {
      current = readFileSync(filePath, 'utf8');
    } catch {
      // No config left to point at the catalog.
    }
    if (current !== null) {
      const currentLines = current.endsWith('\n') ? current.slice(0, -1).split('\n') : current.split('\n');
      if (isManagedCodexCatalogRef(filePath, readTomlTopLevelString(currentLines, 'model_catalog_json'))) {
        writeTextFile(filePath, `${withoutManagedCodexCatalog(filePath, currentLines).join('\n')}\n`);
      }
    }
    removeCodexModelCatalog(filePath);
  }
}

/**
 * Whether a `model_catalog_json` value refers to the catalog we manage: our
 * file name, and that file isn't one of the user's (no record of writing it,
 * or different content). A reference to a missing file of that name is ours.
 */
function isManagedCodexCatalogRef(filePath: string, ref: string | undefined): boolean {
  return ref === CODEX_MODEL_CATALOG_FILE && codexModelCatalogOwner(filePath) !== 'theirs';
}

/**
 * The config without our catalog: back to the user's own if they had one,
 * otherwise no reference at all, since ours names a file that is being deleted.
 */
function withoutManagedCodexCatalog(filePath: string, lines: string[]): string[] {
  const userCatalog = readSelection(filePath)['model_catalog_json'];
  const withoutOurs = isManagedCodexCatalogRef(filePath, readTomlTopLevelString(lines, 'model_catalog_json'))
    ? removeTomlTopLevelKey(lines, 'model_catalog_json')
    : lines;
  return typeof userCatalog === 'string' && readTomlTopLevelString(withoutOurs, 'model_catalog_json') === undefined
    ? setTomlTopLevelString(withoutOurs, 'model_catalog_json', userCatalog)
    : withoutOurs;
}

export function removeCodexProviderFromFile(filePath: string, patch: CodexConfigPatchDef): boolean {
  if (!existsSync(filePath)) return false;
  const raw = readFileSync(filePath, 'utf8');
  const removal = removeCodexProviderTable(raw.split('\n'), patch.providerKey);
  let lines = removal.lines;
  let changed = removal.changed;
  const saved = readSelection(filePath);
  let removeCatalog = false;
  if (isManagedCodexCatalogRef(filePath, readTomlTopLevelString(lines, 'model_catalog_json'))) {
    lines = withoutManagedCodexCatalog(filePath, lines);
    removeCatalog = true;
    changed = true;
  }
  if (readTomlTopLevelString(lines, 'model_provider') === patch.providerKey) {
    lines = removeTomlTopLevelKey(lines, 'model_provider');
    lines = removeTomlTopLevelKey(lines, 'model');
    lines = removeTomlTopLevelKey(lines, 'model_context_window');
    if (typeof saved['model_provider'] === 'string') lines = setTomlTopLevelString(lines, 'model_provider', saved['model_provider']);
    if (typeof saved['model'] === 'string') lines = setTomlTopLevelString(lines, 'model', saved['model']);
    if (typeof saved['model_context_window'] === 'string') lines = setTomlTopLevelValue(lines, 'model_context_window', saved['model_context_window']);
    changed = true;
  }
  if (changed) {
    backupConfigFile(filePath);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    writeTextFile(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }
  // Only once the config no longer points at them, so a failed write can retry.
  if (removeCatalog) removeCodexModelCatalog(filePath);
  forgetSelection(filePath);
  return changed;
}
