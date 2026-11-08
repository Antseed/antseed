/**
 * Codex lists only models in a catalog, so the gateway's models go in a
 * catalog of Antseed's own beside its config. Built and validated by the Codex
 * installed on this machine, so the entries match its version. The config
 * writer decides when to reference, restore or drop it.
 */
import { ANTSEED_MODEL_CONTEXT_WINDOW } from '@antseed/protocol/service-api';
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CODEX_MODEL_CATALOG_FILE = 'antseed-models.json';

type JsonObject = Record<string, unknown>;

function runCodexDebugModels(configPath: string, args: readonly string[] = []): string {
  return execFileSync('codex', ['debug', 'models', ...args], {
    env: { ...process.env, CODEX_HOME: path.dirname(configPath) },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

/**
 * The catalog for `models`. Entries take their instructions and limits from
 * the installed Codex's bundled models. Null when Codex can't be asked.
 */
export function buildCodexModelCatalog(configPath: string, models: ReadonlyArray<{ id: string; label?: string }>): string | null {
  try {
    const bundled = JSON.parse(runCodexDebugModels(configPath, ['--bundled'])) as { models?: JsonObject[] };
    const base = bundled.models?.[0];
    if (!base) return null;
    return JSON.stringify({
      models: models.map((model, priority) => ({
        slug: model.id,
        display_name: model.label ?? model.id,
        description: '',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'medium', description: 'Default' }],
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

export function writeCodexModelCatalog(configPath: string, catalog: string): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(path.join(path.dirname(configPath), CODEX_MODEL_CATALOG_FILE), catalog, 'utf8');
}

/** Throws when Codex can't load its models with the config as it now stands. */
export function validateCodexModelCatalog(configPath: string): void {
  runCodexDebugModels(configPath);
}

export function removeCodexModelCatalog(configPath: string): void {
  try {
    unlinkSync(path.join(path.dirname(configPath), CODEX_MODEL_CATALOG_FILE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
