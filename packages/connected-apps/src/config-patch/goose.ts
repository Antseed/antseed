/**
 * goose (`~/.config/goose/config.yaml`): its flat YAML keys, the Antseed custom
 * provider file, and the state that tells our patch from the user's own setup.
 * config-patch.ts runs it per install (native and WSL) and dispatches to it.
 */
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ANTSEED_MODEL_CONTEXT_WINDOW } from '@antseed/protocol/service-api';
import type { GooseConfigPatchDef, ResolvedTarget } from '../config-patch.js';
import {
  ROUTED_MODEL_ALIAS,
  backupConfigFile,
  forgetSelection,
  pickModel,
  readSelection,
  rememberSelection,
  sha256Hex,
  tryReadConfigPatchFile,
  writeJsonFile,
  writeTextFile,
  type JsonObject,
} from '../config-patch-files.js';

//
// goose config is flat env-style YAML keys (GOOSE_PROVIDER, GOOSE_MODEL,
// OPENAI_HOST, ...), edited line-based so user keys and comments survive.
// OPENAI_HOST is the host root — goose appends the /v1 chat path itself.
// Legacy buyer-proxy patches use OPENAI_HOST and a dummy credential. Gateway
// patches use a custom provider whose Authorization header carries the
// gateway API key; Goose normally reads standard-provider keys from its keyring.

// Characters a YAML parser would fold, drop or reject inside a double-quoted
// scalar: C0 and C1 controls, DEL, the Unicode line and paragraph separators
// and the byte-order mark. They are written as \uXXXX escapes instead.
const YAML_UNSAFE_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g;

/** A YAML double-quoted scalar that reads back as exactly `value`. */
export function yamlScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(YAML_UNSAFE_CHAR, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

const YAML_SIMPLE_ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
};

/** The value of a YAML double-quoted scalar's body (its escapes decoded). */
export function unescapeYamlDoubleQuoted(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (whole, escape: string) => {
    if (escape.length > 1) {
      const code = Number.parseInt(escape.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return YAML_SIMPLE_ESCAPES[escape] ?? escape;
  });
}

export function yamlTopLevelKeyIndex(lines: readonly string[], key: string): number {
  const pattern = new RegExp(`^${key}\\s*:`);
  return lines.findIndex((line) => pattern.test(line));
}

export function setYamlTopLevelString(lines: readonly string[], key: string, value: string): string[] {
  const assignment = `${key}: ${yamlScalar(value)}`;
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index !== -1) {
    const next = [...lines];
    next[index] = assignment;
    return next;
  }
  return [...lines, assignment];
}

export function readYamlTopLevelString(lines: readonly string[], key: string): string | undefined {
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index === -1) return undefined;
  const raw = lines[index]!.slice(lines[index]!.indexOf(':') + 1).trim();
  const doubleQuoted = raw.match(/^"((?:[^"\\]|\\.)*)"/);
  if (doubleQuoted) return unescapeYamlDoubleQuoted(doubleQuoted[1]!);
  const singleQuoted = raw.match(/^'((?:[^']|'')*)'/);
  if (singleQuoted) return singleQuoted[1]!.replace(/''/g, "'");
  return raw.split('#')[0]!.trim();
}

export function removeYamlTopLevelKey(lines: readonly string[], key: string): string[] {
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index === -1) return [...lines];
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

/** True for host values only this patch would have written: a loopback root,
    or one of the WSL-reachable hosts a recorded target carries. */
export function isLoopbackHost(value: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (!value) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(value)) return true;
  return extraHosts.some((host) =>
    new RegExp(`^https?://${host.replace(/[.$]/g, '\\$&')}:\\d+/?$`).test(value));
}


// Gateway patches carry a real key and plain model ids, so the legacy
// ownership checks (dummy 'antseed' key, alias model, loopback host) cannot
// recognize them. A sidecar records the host written and a digest of the key.
export type GoosePatchState = { readonly version: 1; readonly host: string; readonly apiKeySha256: string };

export function goosePatchStatePath(filePath: string): string {
  return `${filePath}.antseed.state.json`;
}

export function readGoosePatchState(filePath: string): GoosePatchState | null {
  let state: JsonObject | null;
  try {
    state = tryReadConfigPatchFile(goosePatchStatePath(filePath));
  } catch {
    return null;
  }
  if (!state || state['version'] !== 1 || typeof state['host'] !== 'string' || typeof state['apiKeySha256'] !== 'string') {
    return null;
  }
  return { version: 1, host: state['host'], apiKeySha256: state['apiKeySha256'] };
}

export function deleteGoosePatchState(filePath: string): void {
  try {
    unlinkSync(goosePatchStatePath(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Goose reads API keys from its keyring, never from config.yaml. A custom
 * provider carries the key as a header, and is the only place that takes a
 * list of models.
 */
export const GOOSE_CUSTOM_PROVIDER = 'custom_antseed';
/** Tells the provider file we wrote from one of the user's under the same name. */
export const GOOSE_CUSTOM_PROVIDER_DESCRIPTION = 'Models on your Antseed gateway';

export function gooseCustomProviderPath(filePath: string): string {
  return path.join(path.dirname(filePath), 'custom_providers', `${GOOSE_CUSTOM_PROVIDER}.json`);
}

/** Where a provider the user already had under our name waits until disconnect. */
export function savedGooseUserProviderPath(filePath: string): string {
  return `${filePath}.antseed.custom-provider.json`;
}

export function readGooseCustomProvider(filePath: string): { exists: boolean; ours: boolean; models: unknown[] } {
  const providerPath = gooseCustomProviderPath(filePath);
  if (!existsSync(providerPath)) return { exists: false, ours: false, models: [] };
  try {
    const provider = tryReadConfigPatchFile(providerPath);
    const ours = provider?.['description'] === GOOSE_CUSTOM_PROVIDER_DESCRIPTION;
    return { exists: true, ours, models: ours && Array.isArray(provider?.['models']) ? provider['models'] : [] };
  } catch {
    return { exists: true, ours: false, models: [] };
  }
}

export function saveGooseUserProvider(filePath: string): void {
  renameSync(gooseCustomProviderPath(filePath), savedGooseUserProviderPath(filePath));
}

/** Removes the provider only if we wrote it; one the user put there stays. */
export function removeGooseCustomProvider(filePath: string): boolean {
  if (!readGooseCustomProvider(filePath).ours) return false;
  unlinkSync(gooseCustomProviderPath(filePath));
  return true;
}

export function restoreGooseUserProvider(filePath: string): boolean {
  const saved = savedGooseUserProviderPath(filePath);
  if (!existsSync(saved)) return false;
  if (readGooseCustomProvider(filePath).exists) {
    // The user made a new one while connected, and that one is the current one.
    unlinkSync(saved);
    return false;
  }
  renameSync(saved, gooseCustomProviderPath(filePath));
  return true;
}

export function rememberGooseSelection(filePath: string, lines: readonly string[]): void {
  const selection: JsonObject = {};
  for (const key of ['GOOSE_PROVIDER', 'GOOSE_MODEL']) {
    const value = readYamlTopLevelString(lines, key);
    if (value !== undefined) selection[key] = value;
  }
  rememberSelection(filePath, selection);
}

/** What the old buyer-proxy patch wrote: a dummy key, or our alias or a pinned model. */
export function hasLegacyGooseSignature(apiKey: string | undefined, model: string | undefined): boolean {
  return apiKey === 'antseed' || model === ROUTED_MODEL_ALIAS || (model?.includes('@') ?? false);
}

export function applyGooseCustomProviderToFile(filePath: string, patch: GooseConfigPatchDef, baseURL: string, t: ResolvedTarget): void {
  backupConfigFile(filePath);
  const previous = existsSync(filePath) ? readFileSync(filePath, 'utf8').split('\n') : [];
  const provider = readYamlTopLevelString(previous, 'GOOSE_PROVIDER');
  // A pick from an earlier patch (which pointed goose's openai provider at the
  // gateway) is still the user's. A legacy buyer-proxy patch is ours too, though
  // its alias isn't a pick: the user's own selection was saved when it was written.
  const previousModel = readYamlTopLevelString(previous, 'GOOSE_MODEL');
  const legacyPatch = provider === patch.providerKey
    && hasLegacyGooseSignature(readYamlTopLevelString(previous, 'OPENAI_API_KEY'), previousModel);
  const existingProvider = readGooseCustomProvider(filePath);
  const userProvider = existingProvider.exists && !existingProvider.ours;
  const owned = (provider === GOOSE_CUSTOM_PROVIDER && !userProvider) || legacyPatch || (provider === patch.providerKey && readGoosePatchState(filePath) !== null);
  // Model discovery failed for now: the pick and the list stay until it's back.
  const selected = pickModel(t, owned ? previousModel : undefined) ?? (owned && !legacyPatch ? previousModel : undefined);
  const models = t.models.length > 0
    ? t.models.map((model) => ({ name: model.id, context_limit: ANTSEED_MODEL_CONTEXT_WINDOW }))
    : existingProvider.models;
  if (!owned) rememberGooseSelection(filePath, previous);
  // Everything from here to the config write comes undone together on a
  // failure, so goose keeps a provider and selection that match: the user's own
  // custom_antseed back where it was, or the provider as it was before.
  const providerPath = gooseCustomProviderPath(filePath);
  const providerBefore = existsSync(providerPath) ? readFileSync(providerPath, 'utf8') : null;
  let movedUserProvider = false;
  const earlierState = readGoosePatchState(filePath);
  try {
    if (userProvider) {
      saveGooseUserProvider(filePath);
      movedUserProvider = true;
    }
    // Only an earlier patch of ours has anything to clean up: a local endpoint the
    // user set up for goose's own openai provider isn't ours, and stays. The
    // cleanup is planned in memory and lands with the one config write below,
    // so a failure before it leaves the old config (and its state) working.
    const cleansEarlierPatch = owned || earlierState !== null || readYamlTopLevelString(previous, 'OPENAI_API_KEY') === 'antseed';
    let lines = cleansEarlierPatch ? planGooseCleanup(filePath, previous, patch, [], true).lines : [...previous];
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines = setYamlTopLevelString(lines, 'GOOSE_PROVIDER', GOOSE_CUSTOM_PROVIDER);
    if (selected) lines = setYamlTopLevelString(lines, 'GOOSE_MODEL', selected);
    // The provider first: if it can't be written, goose still selects what it
    // had, rather than a provider that doesn't exist.
    writeJsonFile(providerPath, {
      name: GOOSE_CUSTOM_PROVIDER,
      engine: 'openai',
      display_name: 'Antseed',
      description: GOOSE_CUSTOM_PROVIDER_DESCRIPTION,
      api_key_env: '',
      base_url: `${baseURL}/v1/chat/completions`,
      models,
      // Goose otherwise lists the gateway's whole /v1/models (image, video and
      // speech models included) instead of `models`. It refuses `false` with
      // no models, so the key is left out when there is no list at all; a
      // kept earlier list (models didn't load this time) still turns it off.
      ...(Array.isArray(models) && models.length > 0 ? { dynamic_models: false } : {}),
      headers: { Authorization: `Bearer ${t.apiKey}` },
      supports_streaming: true,
      requires_auth: false,
    });
    writeTextFile(filePath, `${lines.join('\n')}\n`);
  } catch (err) {
    try {
      if (movedUserProvider) {
        rmSync(providerPath, { force: true });
        renameSync(savedGooseUserProviderPath(filePath), providerPath);
      } else if (providerBefore === null) {
        rmSync(providerPath, { force: true });
      } else {
        writeTextFile(providerPath, providerBefore);
      }
    } catch {
      // The write's own failure is the one to report.
    }
    throw err;
  }
  // The config write commits the migration: the provider and config agree
  // from here, so a failed cleanup of the earlier patch's ownership record
  // can't roll them apart, and the next refresh deletes it again.
  if (earlierState) {
    try {
      deleteGoosePatchState(filePath);
    } catch {
      // Left for the next refresh.
    }
  }
}

export function applyGooseProviderToFile(filePath: string, patch: GooseConfigPatchDef, baseURL: string, t: ResolvedTarget): void {
  if (!t.legacy) {
    applyGooseCustomProviderToFile(filePath, patch, baseURL, t);
    return;
  }
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const provider = readYamlTopLevelString(lines, 'GOOSE_PROVIDER');
  // Coming from our gateway provider: the user's own selection was saved when
  // that was written, and the pick in it is theirs.
  const fromOurGateway = provider === GOOSE_CUSTOM_PROVIDER && readGooseCustomProvider(filePath).ours;
  const ownedSelection = provider === patch.providerKey || fromOurGateway
    ? readYamlTopLevelString(lines, 'GOOSE_MODEL')
    : undefined;
  const selected = pickModel(t, ownedSelection);
  if (provider !== patch.providerKey && !fromOurGateway) rememberGooseSelection(filePath, lines);
  lines = setYamlTopLevelString(lines, 'GOOSE_PROVIDER', patch.providerKey);
  if (selected) lines = setYamlTopLevelString(lines, 'GOOSE_MODEL', selected);
  lines = setYamlTopLevelString(lines, 'OPENAI_HOST', baseURL);
  lines = setYamlTopLevelString(lines, 'OPENAI_API_KEY', t.apiKey);
  writeTextFile(filePath, `${lines.join('\n')}\n`);
  // Only once nothing selects it any more.
  if (fromOurGateway) removeGooseCustomProvider(filePath);
  deleteGoosePatchState(filePath);
}


export function removeGooseProviderFromFile(
  filePath: string,
  patch: GooseConfigPatchDef,
  extraHosts: readonly string[],
  { keepSelection = false }: { keepSelection?: boolean } = {},
): boolean {
  const state = readGoosePatchState(filePath);
  if (!existsSync(filePath)) {
    // The config is gone (reset or deleted), so nothing selects our provider,
    // but its file still holds the gateway key: remove it all the same.
    if (keepSelection) return false;
    const removed = removeGooseCustomProvider(filePath);
    const restored = restoreGooseUserProvider(filePath);
    if (state) deleteGoosePatchState(filePath);
    forgetSelection(filePath);
    return removed || restored || state !== null;
  }
  const plan = planGooseCleanup(filePath, readFileSync(filePath, 'utf8').split('\n'), patch, extraHosts, keepSelection);
  if (plan.changed) {
    backupConfigFile(filePath);
    const lines = [...plan.lines];
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    writeTextFile(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }
  // Only after the write: until the config stops selecting our provider it
  // must stay, and a failed write can be retried with the user's one still saved.
  if (plan.removesProvider) removeGooseCustomProvider(filePath);
  if (!keepSelection) restoreGooseUserProvider(filePath);
  if (state) deleteGoosePatchState(filePath);
  if (!keepSelection) forgetSelection(filePath);
  return plan.changed || state !== null;
}

/**
 * What removing our patch does to the config, worked out without touching
 * any file: the config's new lines, whether that changes anything, and
 * whether our custom provider file goes once those lines are written.
 * `keepSelection` (a refresh) keeps our provider and its selection: the
 * replacement overwrites them.
 */
export function planGooseCleanup(
  filePath: string,
  original: readonly string[],
  patch: GooseConfigPatchDef,
  extraHosts: readonly string[],
  keepSelection: boolean,
): { lines: string[]; changed: boolean; removesProvider: boolean } {
  let lines = [...original];
  const state = readGoosePatchState(filePath);
  const provider = readGooseCustomProvider(filePath);
  const removesProvider = !keepSelection && provider.ours;
  let changed = removesProvider;
  // Selecting a provider of the user's own under that name isn't our patch.
  if (!keepSelection && readYamlTopLevelString(lines, 'GOOSE_PROVIDER') === GOOSE_CUSTOM_PROVIDER && (provider.ours || !provider.exists)) {
    lines = removeYamlTopLevelKey(lines, 'GOOSE_PROVIDER');
    lines = removeYamlTopLevelKey(lines, 'GOOSE_MODEL');
    changed = true;
  }
  const host = readYamlTopLevelString(lines, 'OPENAI_HOST');
  const ownsGatewayHost = state !== null && host === state.host;
  const apiKey = readYamlTopLevelString(lines, 'OPENAI_API_KEY');
  const legacyModel = readYamlTopLevelString(lines, 'GOOSE_MODEL');
  // The buyer-proxy patch wrote a loopback host with a dummy key and an alias
  // model. A loopback host without those is the user's own local server.
  const legacyProxyPatch = hasLegacyGooseSignature(apiKey, legacyModel);
  if ((isLoopbackHost(host, extraHosts) && legacyProxyPatch) || ownsGatewayHost) {
    lines = removeYamlTopLevelKey(lines, 'OPENAI_HOST');
    changed = true;
  }
  if (apiKey === 'antseed' || (state !== null && apiKey !== undefined && sha256Hex(apiKey) === state.apiKeySha256)) {
    lines = removeYamlTopLevelKey(lines, 'OPENAI_API_KEY');
    changed = true;
  }
  const model = readYamlTopLevelString(lines, 'GOOSE_MODEL');
  // A gateway-written provider still pointing at the recorded host is ours
  // whatever model the user picked in goose since.
  const ownsModel = model === ROUTED_MODEL_ALIAS || (model?.includes('@') ?? false) || ownsGatewayHost;
  if (readYamlTopLevelString(lines, 'GOOSE_PROVIDER') === patch.providerKey && ownsModel) {
    lines = removeYamlTopLevelKey(lines, 'GOOSE_PROVIDER');
    lines = removeYamlTopLevelKey(lines, 'GOOSE_MODEL');
    changed = true;
  }
  if (!keepSelection) {
    // The user's own provider comes back after the write, in place of ours.
    const restoresProvider = existsSync(savedGooseUserProviderPath(filePath)) && (!provider.exists || removesProvider);
    changed = restoresProvider || changed;
    const saved = readSelection(filePath);
    if (changed && readYamlTopLevelString(lines, 'GOOSE_PROVIDER') === undefined) {
      for (const key of ['GOOSE_PROVIDER', 'GOOSE_MODEL']) {
        if (typeof saved[key] === 'string') lines = setYamlTopLevelString(lines, key, saved[key]);
      }
    }
  }
  return { lines, changed, removesProvider };
}
