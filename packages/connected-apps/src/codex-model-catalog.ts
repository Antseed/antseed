/**
 * Codex lists only models in a catalog, so the gateway's models go in a
 * catalog of Antseed's own beside its config. Built and validated by the Codex
 * installed on this machine, so the entries match its version. The config
 * writer decides when to reference, restore or drop it.
 */
import { ANTSEED_MODEL_CONTEXT_WINDOW } from '@antseed/protocol/service-api';
import { execFile } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  CONNECTED_APP_DEFAULT_REASONING,
  CONNECTED_APP_REASONING_LEVELS,
  sha256Hex,
  writeTextFile,
  type ConfigPatchModel,
} from './config-patch-files.js';

export const CODEX_MODEL_CATALOG_FILE = 'antseed-models.json';

type JsonObject = Record<string, unknown>;

/**
 * Asynchronous so a slow Codex never blocks the caller's thread (the desktop
 * runs this in its main process).
 */
function runCodexDebugModels(configPath: string, args: readonly string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('codex', ['debug', 'models', ...args], {
      env: { ...process.env, CODEX_HOME: path.dirname(configPath) },
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end();
  });
}

const CODEX_REASONING_DESCRIPTIONS: Record<string, string> = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
};

/** A reasoning model gets Codex's effort selector; any other gets none, so Codex sends no effort. */
function codexReasoningFields(model: ConfigPatchModel): JsonObject {
  return model.reasoning
    ? {
        default_reasoning_level: CONNECTED_APP_DEFAULT_REASONING,
        supported_reasoning_levels: CONNECTED_APP_REASONING_LEVELS.map((effort) => ({ effort, description: CODEX_REASONING_DESCRIPTIONS[effort] ?? effort })),
      }
    : { supported_reasoning_levels: [] };
}

/**
 * The catalog for `models`. Entries take their instructions and limits from
 * the installed Codex's bundled models. Null when Codex can't be asked.
 */
export async function buildCodexModelCatalog(configPath: string, models: ReadonlyArray<ConfigPatchModel>): Promise<string | null> {
  try {
    const bundled = JSON.parse(await runCodexDebugModels(configPath, ['--bundled'])) as { models?: JsonObject[] };
    const base = bundled.models?.[0];
    if (!base) return null;
    return JSON.stringify({
      models: models.map((model, priority) => ({
        slug: model.id,
        display_name: model.label ?? model.id,
        description: '',
        ...codexReasoningFields(model),
        // The bundled GPT entries use tools other models can't call.
        shell_type: 'shell_command',
        apply_patch_tool_type: 'freeform',
        experimental_supported_tools: [],
        visibility: 'list',
        supported_in_api: true,
        priority,
        support_verbosity: false,
        context_window: ANTSEED_MODEL_CONTEXT_WINDOW,
        truncation_policy: base['truncation_policy'],
        base_instructions: base['base_instructions'],
      })),
    });
  } catch {
    return null;
  }
}

/** Records the digest of the catalog we wrote, so only that file is ever replaced or deleted. */
function catalogOwnershipPath(configPath: string): string {
  return `${configPath}.antseed.catalog.json`;
}

function catalogPath(configPath: string): string {
  return path.join(path.dirname(configPath), CODEX_MODEL_CATALOG_FILE);
}

/**
 * Whose `antseed-models.json` sits beside the config: none, ours (its content
 * is what we recorded writing), or the user's own under the same name.
 */
export function codexModelCatalogOwner(configPath: string): 'none' | 'ours' | 'theirs' {
  let content: string;
  try {
    content = readFileSync(catalogPath(configPath), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    return 'theirs';
  }
  try {
    const record = JSON.parse(readFileSync(catalogOwnershipPath(configPath), 'utf8')) as { sha256?: unknown };
    return record.sha256 === sha256Hex(content) ? 'ours' : 'theirs';
  } catch {
    return 'theirs';
  }
}

/**
 * Writes our catalog; false (nothing written) when a catalog of the user's has
 * that name. When its record can't be written, the catalog goes back to what
 * it was, so the file on disk still matches the record and stays ours.
 */
export function writeCodexModelCatalog(configPath: string, catalog: string): boolean {
  if (codexModelCatalogOwner(configPath) === 'theirs') return false;
  const previous = readIfPresent(catalogPath(configPath));
  writeTextFile(catalogPath(configPath), catalog);
  try {
    writeTextFile(catalogOwnershipPath(configPath), `${JSON.stringify({ version: 1, sha256: sha256Hex(catalog) })}\n`);
  } catch (err) {
    if (previous === null) unlinkIfPresent(catalogPath(configPath));
    else writeTextFile(catalogPath(configPath), previous);
    throw err;
  }
  return true;
}

function readIfPresent(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Whether the catalog on disk is still `catalog` (one a newer refresh replaced is not). */
export function codexModelCatalogIs(configPath: string, catalog: string): boolean {
  try {
    return readFileSync(catalogPath(configPath), 'utf8') === catalog;
  } catch {
    return false;
  }
}

/** Throws when Codex can't load its models with the config as it now stands. */
export async function validateCodexModelCatalog(configPath: string): Promise<void> {
  await runCodexDebugModels(configPath);
}

/** Deletes our catalog and its record; a catalog of the user's under that name stays. */
export function removeCodexModelCatalog(configPath: string): void {
  if (codexModelCatalogOwner(configPath) === 'ours') unlinkIfPresent(catalogPath(configPath));
  unlinkIfPresent(catalogOwnershipPath(configPath));
}

function unlinkIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
