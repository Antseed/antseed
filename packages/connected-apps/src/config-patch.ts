import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/protocol/service-api';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Document, parseDocument } from 'yaml';
import {
  WSL_TOOL_PROBES,
  clearWslTargetsForTool,
  discoverWslToolTargets,
  readWslTargetsForTool,
  saveWslTargetsForTool,
  type WslConfigTarget,
  type WslTool,
} from './wsl.js';

/**
 * Model alias resolved by the buyer proxy at request time to the route
 * currently selected in the desktop (floating pill / AI VPN). Must match
 * ROUTED_MODEL_ALIAS in apps/cli/src/proxy/request-utils.ts.
 */
export const ROUTED_MODEL_ALIAS = 'antseed';
const ROUTED_MODEL_ALIAS_LABEL = 'Antseed Auto';
// Droid requires the `custom:` namespace to resolve this through `customModels`;
// an unprefixed value is treated as a Factory-managed model and triggers Factory authentication.
const DROID_ROUTED_MODEL_ID = 'custom:Antseed-Auto-0';

/**
 * Config patches point a tool's own configuration at the buyer proxy. Each
 * supported tool has its own on-disk format:
 *  - `opencode` (default): JSONC `provider` map (OpenCode's opencode.jsonc)
 *  - `codex`: TOML `[model_providers.*]` table (Codex CLI's config.toml)
 *  - `droid`: JSON `customModels` array plus default model (Factory settings.json)
 *  - `pi`: JSON providers map plus a settings file (pi's models.json/settings.json)
 *  - `crush`: JSON `providers` map with an openai-compat entry (Crush's crush.json)
 *  - `goose`: flat env-style YAML keys (goose's config.yaml)
 *  - `hermes`: nested YAML provider + model selection (Hermes' config.yaml)
 *  - `zed`: JSONC settings with `language_models.openai_compatible` (Zed's settings.json)
 *  - `claude-code`: JSON `env` and `model` keys (Claude Code's user settings.json)
 */
export type OpencodeConfigPatchDef = {
  readonly format?: 'opencode';
  readonly configPath: string;
  readonly providerKey: string;
  readonly npm: string;
  readonly providerName: string;
  readonly baseURL: string;
  /** When set, the patcher targets actual installations of the named tool —
      native only if install signals exist, plus every WSL distro carrying it
      (Windows) — and throws when the tool is found nowhere, instead of
      blindly creating a config for a program that isn't there. Unset keeps
      the write-the-one-path behavior for generic/external profiles.
      See applyWithInstallProbe. */
  readonly installProbe?: 'opencode';
};

export type CodexConfigPatchDef = {
  readonly format: 'codex';
  readonly configPath: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
  readonly installProbe?: 'codex';
};

export type DroidConfigPatchDef = {
  readonly format: 'droid';
  /** Droid CLI and Factory Desktop's shared user settings. */
  readonly configPath: string;
  /** Custom model ID sent to the buyer proxy. */
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
  readonly originator?: string;
  readonly installProbe?: 'droid';
};

export type PiConfigPatchDef = {
  readonly format: 'pi';
  /** pi models.json (custom providers). */
  readonly configPath: string;
  /** pi settings.json (default provider/model selection). */
  readonly settingsPath: string;
  readonly providerKey: string;
  readonly baseURL: string;
  readonly api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  readonly originator?: string;
  readonly installProbe?: 'pi' | 'prime-agent';
};

export type CrushConfigPatchDef = {
  readonly format: 'crush';
  readonly configPath: string;
  /** POSIX config path for WSL installs — `configPath` is resolved to a
      Windows known folder at definition time, which is meaningless inside a
      distro. */
  readonly wslConfigPath?: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
  readonly installProbe?: 'crush';
};

export type GooseConfigPatchDef = {
  readonly format: 'goose';
  /** goose config.yaml (flat env-style keys). */
  readonly configPath: string;
  /** POSIX config path for WSL installs — see CrushConfigPatchDef. */
  readonly wslConfigPath?: string;
  /** goose provider engine ('openai' for openai-compatible hosts). */
  readonly providerKey: string;
  /** Host root without /v1 — goose appends the chat-completions path itself. */
  readonly baseURL: string;
  readonly installProbe?: 'goose';
};

export type HermesConfigPatchDef = {
  readonly format: 'hermes';
  /** Hermes user configuration (`~/.hermes/config.yaml`). */
  readonly configPath: string;
  /** Key under Hermes' named `providers` map. */
  readonly providerKey: string;
  readonly baseURL: string;
};

export type ZedConfigPatchDef = {
  readonly format: 'zed';
  readonly configPath: string;
  readonly providerKey: string;
  /** Key under language_models.openai_compatible; also the agent provider id. */
  readonly providerName: string;
  readonly baseURL: string;
};

export type ClaudeCodeConfigPatchDef = {
  readonly format: 'claude-code';
  readonly configPath: string;
  readonly providerKey: string;
  readonly baseURL: string;
  readonly installProbe?: 'claude';
};

export type T3CodeConfigPatchDef = {
  readonly format: 't3code';
  readonly configPath: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
};

/**
 * Claude Desktop ships a native third-party inference mode: when the profile
 * config says `deploymentMode: "3p"` it boots against a separate profile
 * directory (`Claude-3p`) whose applied entry in `configLibrary/` names an
 * Anthropic-Messages-compatible gateway to send all inference to. The patch
 * writes that profile pointing at the desktop's local Claude gateway (see
 * apps/desktop/src/main/connected-apps/claude-desktop-gateway.ts), which serves the model catalog
 * in Anthropic's native shape and forwards requests to the buyer proxy. The
 * 1p and 3p profiles are separate directories, so the user's normal Claude
 * login and state are untouched.
 */
export type ClaudeDesktopConfigPatchDef = {
  readonly format: 'claude-desktop';
  /** Claude's normal-profile claude_desktop_config.json (deploymentMode
      flip). posix only — Windows candidates come from
      claudeDesktopPatchTargets, which probes every known install layout. */
  readonly configPath: string;
  /** Claude's third-party profile root (the `Claude-3p` directory). */
  readonly thirdPartyDir: string;
  /** Gateway base URL carrying the `{claudeGatewayPort}` placeholder. */
  readonly baseURL: string;
};

export type ConfigPatchDef =
  | OpencodeConfigPatchDef
  | CodexConfigPatchDef
  | DroidConfigPatchDef
  | PiConfigPatchDef
  | CrushConfigPatchDef
  | GooseConfigPatchDef
  | HermesConfigPatchDef
  | ZedConfigPatchDef
  | ClaudeCodeConfigPatchDef
  | T3CodeConfigPatchDef
  | ClaudeDesktopConfigPatchDef;

/**
 * Loopback port of the desktop's Claude Desktop gateway. Lives here (not in
 * the desktop's claude-desktop-gateway.ts) so this electron-free module stays the single
 * import direction: the gateway imports from config-patch, never the reverse.
 */
export const CLAUDE_GATEWAY_DEFAULT_PORT = Number(process.env['ANTSEED_CLAUDE_GATEWAY_PORT']) || 8380;
/** Fixed id of the managed third-party profile entry in Claude's configLibrary. */
export const CLAUDE_DESKTOP_PROFILE_ID = '00000000-0000-4000-8000-0000a4753eed';
const CLAUDE_DESKTOP_PROFILE_NAME = 'Antseed';

export function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function readRequiredString(raw: Record<string, unknown>, key: string, context: string | number): string {
  const value = readString(raw, key);
  if (!value) throw new Error(`System Proxy profile ${context} requires ${key}`);
  return value;
}

/** Parses a profile's configPatch blob into a ConfigPatchDef. Every format in
 *  the union needs its own branch here — an unmatched format falls through to
 *  opencode, whose `npm` requirement then throws at profile load (i.e. app
 *  startup). Lives in this electron-free module so tests can feed every
 *  default profile through it. */
export function readConfigPatch(value: unknown, profileName: string): ConfigPatchDef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`configPatch for ${profileName} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const format = readString(raw, 'format');
  // Claude Desktop's gateway profile has no provider entry of its own —
  // auth is a placeholder key the loopback gateway ignores — so it skips
  // the providerKey every other format requires.
  if (format === 'claude-desktop') {
    return {
      format: 'claude-desktop',
      configPath: readRequiredString(raw, 'configPath', profileName),
      thirdPartyDir: readRequiredString(raw, 'thirdPartyDir', profileName),
      baseURL: readRequiredString(raw, 'baseURL', profileName),
    };
  }
  const configPath = readRequiredString(raw, 'configPath', profileName);
  const providerKey = readRequiredString(raw, 'providerKey', profileName);
  const baseURL = readRequiredString(raw, 'baseURL', profileName);
  if (format === 'codex') {
    return {
      format: 'codex',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
      ...(raw['installProbe'] === 'codex' ? { installProbe: 'codex' as const } : {}),
    };
  }
  if (format === 'droid') {
    const originator = readString(raw, 'originator');
    return {
      format: 'droid',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
      ...(originator ? { originator } : {}),
      ...(raw['installProbe'] === 'droid' ? { installProbe: 'droid' as const } : {}),
    };
  }
  if (format === 'pi') {
    const api = raw['api'];
    const originator = readString(raw, 'originator');
    const installProbe = raw['installProbe'];
    return {
      format: 'pi',
      configPath,
      settingsPath: readRequiredString(raw, 'settingsPath', profileName),
      providerKey,
      baseURL,
      api: api === 'openai-responses' || api === 'anthropic-messages' ? api : 'openai-completions',
      ...(originator ? { originator } : {}),
      ...(installProbe === 'pi' || installProbe === 'prime-agent' ? { installProbe } : {}),
    };
  }
  if (format === 'crush') {
    const wslConfigPath = readString(raw, 'wslConfigPath');
    return {
      format: 'crush',
      configPath,
      ...(wslConfigPath ? { wslConfigPath } : {}),
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
      ...(raw['installProbe'] === 'crush' ? { installProbe: 'crush' as const } : {}),
    };
  }
  if (format === 'goose') {
    const wslConfigPath = readString(raw, 'wslConfigPath');
    return {
      format: 'goose',
      configPath,
      ...(wslConfigPath ? { wslConfigPath } : {}),
      providerKey,
      baseURL,
      ...(raw['installProbe'] === 'goose' ? { installProbe: 'goose' as const } : {}),
    };
  }
  if (format === 'hermes') {
    return {
      format: 'hermes',
      configPath,
      providerKey,
      baseURL,
    };
  }
  if (format === 'zed') {
    return {
      format: 'zed',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
    };
  }
  if (format === 'claude-code') {
    return {
      format: 'claude-code',
      configPath,
      providerKey,
      baseURL,
      ...(raw['installProbe'] === 'claude' ? { installProbe: 'claude' as const } : {}),
    };
  }
  if (format === 't3code') {
    return {
      format: 't3code',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
    };
  }
  return {
    format: 'opencode',
    configPath,
    providerKey,
    npm: readRequiredString(raw, 'npm', profileName),
    providerName: readRequiredString(raw, 'providerName', profileName),
    baseURL,
    ...(raw['installProbe'] === 'opencode' ? { installProbe: 'opencode' as const } : {}),
  };
}

type JsonObject = Record<string, unknown>;

function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

function isBuyerProxyRoutablePeerId(peerId: string): boolean {
  const normalized = peerId.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{40}$/.test(normalized);
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

function readJsoncFile(filePath: string): JsonObject | null {
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

function readConfigPatchFile(filePath: string): JsonObject {
  if (!existsSync(filePath)) {
    return {};
  }
  return readJsoncFile(filePath) ?? {};
}

function tryReadConfigPatchFile(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return readJsoncFile(filePath);
}

function writeJsonFile(filePath: string, data: JsonObject): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function backupConfigFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.antseed.bak`;
  if (existsSync(backupPath)) return;
  copyFileSync(filePath, backupPath);
}

function removeFromStringArray(config: JsonObject, key: string, value: string): void {
  const arr = config[key];
  if (!Array.isArray(arr)) return;
  const filtered = arr.filter((item) => item !== value);
  if (filtered.length === 0) delete config[key];
  else config[key] = filtered;
}

/**
 * Point the tool's config at the buyer proxy. The config exposes a single
 * model — the ROUTED_MODEL_ALIAS — which the buyer resolves per request to
 * the route currently selected in the desktop (floating pill / AI VPN). Concrete
 * `<peerId>@<service>` entries are no longer written: the only place to pick
 * a model is the desktop route selector, so route changes reach running tool
 * sessions without a config rewrite.
 */
export function applyConfigPatch(patch: ConfigPatchDef, peerId: string, buyerPort: number, wslTargetsFile?: string): void {
  if (!isBuyerProxyRoutablePeerId(peerId)) {
    throw new Error('Config-based routing requires a 40-character hex peer ID. Select a chain-backed peer before enabling this tool.');
  }
  writeConfigPatch(patch, buyerPort, wslTargetsFile);
}

/**
 * The config write behind applyConfigPatch, without the selected-peer guard.
 * The patched config only carries the ROUTED_MODEL_ALIAS, so no peer is
 * written either way; callers that do not own a route selection (the CLI's
 * `antseed apps connect`) use this and leave route choice to the buyer.
 */
export function writeConfigPatch(patch: ConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  if (patch.format === 'codex') {
    applyCodexConfigPatch(patch, buyerPort, wslTargetsFile);
    return;
  }
  if (patch.format === 'droid') {
    applyDroidConfigPatch(patch, buyerPort, wslTargetsFile);
    return;
  }
  if (patch.format === 'pi') {
    applyPiConfigPatch(patch, buyerPort, wslTargetsFile);
    return;
  }
  if (patch.format === 'crush') {
    applyCrushConfigPatch(patch, buyerPort, wslTargetsFile);
    return;
  }
  if (patch.format === 'goose') {
    applyGooseConfigPatch(patch, buyerPort, wslTargetsFile);
    return;
  }
  if (patch.format === 'hermes') {
    applyHermesConfigPatch(patch, buyerPort);
    return;
  }
  if (patch.format === 'zed') {
    applyZedConfigPatch(patch, buyerPort);
    return;
  }
  if (patch.format === 'claude-code') {
    applyClaudeCodeConfigPatch(patch, buyerPort, wslTargetsFile);
    return;
  }
  if (patch.format === 't3code') {
    applyT3CodeConfigPatch(patch, buyerPort);
    return;
  }
  if (patch.format === 'claude-desktop') {
    applyClaudeDesktopConfigPatch(patch);
    return;
  }
  applyOpencodeConfigPatch(patch, buyerPort, wslTargetsFile);
}

/** Replace the host of a base URL, leaving scheme, port, and path untouched.
    Regex rather than URL because the string may still carry the `{buyerPort}`
    placeholder, which URL refuses to parse. */
export function substituteBaseUrlHost(baseURL: string, host: string): string {
  return baseURL.replace(/^(https?:\/\/)[^/:]+/, `$1${host}`);
}

/** Signals that a tool actually exists natively: its config dir, its
    home-relative install/state locations (shared with the WSL probe), or the
    binary on PATH. Any one suffices — a GUI process sees a reduced PATH, and
    some tools only create the config dir once configured. */
function nativeToolInstalled(tool: WslTool, configFilePath: string): boolean {
  if (existsSync(path.dirname(configFilePath))) return true;
  const probe = WSL_TOOL_PROBES[tool];
  if (probe.signals.some((signal) => existsSync(path.join(homedir(), ...signal.split('/'))))) return true;
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [probe.binary], { stdio: 'ignore', windowsHide: true });
    } else {
      execFileSync('/bin/sh', ['-c', `command -v ${probe.binary}`], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

type PatchFilePaths = { configPath: string; settingsPath?: string };

/**
 * Shared install-probe patching: write the config to the native install only
 * when install signals exist, write it into every WSL distro carrying the
 * tool (with a base URL host that distro can reach), remember the WSL
 * targets for removal, and throw when the tool is found nowhere.
 */
function applyWithInstallProbe(opts: {
  tool: WslTool;
  native: PatchFilePaths;
  /** `~/`-rooted config locations, for mapping into WSL distros. */
  posix: PatchFilePaths;
  baseURL: string;
  wslTargetsFile?: string;
  write: (paths: PatchFilePaths, baseURL: string) => void;
}): void {
  const nativeInstalled = nativeToolInstalled(opts.tool, opts.native.configPath);
  const wslTargets = discoverWslToolTargets(opts.tool, opts.posix);
  if (!nativeInstalled && wslTargets.length === 0) {
    throw new Error(
      `${opts.tool} was not found on this machine`
      + (process.platform === 'win32' ? ' or in any WSL distro' : '')
      + ` — nothing to connect. Looked for ${path.dirname(opts.native.configPath)}, `
      + `its home install locations, and a ${WSL_TOOL_PROBES[opts.tool].binary} binary on PATH. `
      + `Install ${opts.tool} (or run it once), then reconnect.`,
    );
  }
  if (nativeInstalled) opts.write(opts.native, opts.baseURL);
  for (const target of wslTargets) {
    // Inside WSL, `localhost` is the distro's own VM under NAT networking —
    // the config must carry the host the distro can actually reach the
    // Windows-side buyer proxy on.
    opts.write(
      { configPath: target.configPath, ...(target.settingsPath ? { settingsPath: target.settingsPath } : {}) },
      substituteBaseUrlHost(opts.baseURL, target.host),
    );
  }
  if (opts.wslTargetsFile) saveWslTargetsForTool(opts.wslTargetsFile, opts.tool, wslTargets);
}

/** Unpatch the WSL targets remembered for `tool` and forget them. */
function removeWslInstalls(
  tool: WslTool,
  wslTargetsFile: string | undefined,
  removeFrom: (target: WslConfigTarget) => boolean,
): boolean {
  if (!wslTargetsFile) return false;
  let changed = false;
  for (const target of readWslTargetsForTool(wslTargetsFile, tool)) {
    try {
      if (removeFrom(target)) changed = true;
    } catch {
      // Distro stopped or the UNC share is unavailable. The stale provider
      // entry is inert (it points at a dead host/port) and the next connect
      // rewrites it.
    }
  }
  clearWslTargetsForTool(wslTargetsFile, tool);
  return changed;
}

function applyOpencodeConfigPatch(patch: OpencodeConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'opencode') {
    applyOpencodeProviderToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'opencode',
    native: { configPath: filePath },
    posix: { configPath: patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyOpencodeProviderToFile(paths.configPath, patch, url),
  });
}

function applyOpencodeProviderToFile(filePath: string, patch: OpencodeConfigPatchDef, baseURL: string): void {
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);

  const providers = (config['provider'] && typeof config['provider'] === 'object' && !Array.isArray(config['provider']))
    ? config['provider'] as JsonObject
    : {};
  providers[patch.providerKey] = {
    name: patch.providerName,
    npm: patch.npm,
    options: {
      baseURL,
      apiKey: 'antseed',
    },
    models: {
      [ROUTED_MODEL_ALIAS]: {
        name: ROUTED_MODEL_ALIAS_LABEL,
        attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
      },
    },
  };
  config['provider'] = providers;
  config['model'] = `${patch.providerKey}/${ROUTED_MODEL_ALIAS}`;
  removeFromStringArray(config, 'disabled_providers', patch.providerKey);

  writeJsonFile(filePath, config);
}

export function removeConfigPatch(patch: ConfigPatchDef, wslTargetsFile?: string): boolean {
  if (patch.format === 'codex') {
    return removeCodexConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'droid') {
    return removeDroidConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'pi') {
    return removePiConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'crush') {
    return removeCrushConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'goose') {
    return removeGooseConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'hermes') {
    return removeHermesConfigPatch(patch);
  }
  if (patch.format === 'zed') {
    return removeZedConfigPatch(patch);
  }
  if (patch.format === 'claude-code') {
    return removeClaudeCodeConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 't3code') {
    return removeT3CodeConfigPatch(patch);
  }
  if (patch.format === 'claude-desktop') {
    return removeClaudeDesktopConfigPatch(patch);
  }
  let changed = removeOpencodeProviderFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'opencode') {
    changed = removeWslInstalls('opencode', wslTargetsFile, (target) => removeOpencodeProviderFromFile(target.configPath, patch)) || changed;
  }
  return changed;
}

function removeOpencodeProviderFromFile(filePath: string, patch: OpencodeConfigPatchDef): boolean {
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  backupConfigFile(filePath);

  let changed = false;
  const providers = config['provider'];
  if (providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    delete (providers as JsonObject)[patch.providerKey];
    changed = true;
  }
  if (typeof config['model'] === 'string' && config['model'].startsWith(`${patch.providerKey}/`)) {
    delete config['model'];
    changed = true;
  }
  if (!changed) return false;
  writeJsonFile(filePath, config);
  return true;
}

function writeTextFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, 'utf8');
}

// --- Droid CLI + Factory Desktop (`~/.factory/settings.json`) ---
//
// Both clients watch this file and share its `customModels` catalog. The
// sidecar remembers only the fields Antseed temporarily owns so disconnect
// can restore the user's prior default without rolling back unrelated edits.

type DroidPatchState = {
  readonly version: 1 | 2;
  readonly configExisted: boolean;
  readonly customModelsPresent: boolean;
  readonly modelPresent: boolean;
  readonly modelValue?: unknown;
  readonly sessionDefaultSettingsPresent: boolean;
  readonly sessionDefaultModelPresent: boolean;
  readonly sessionDefaultModelValue?: unknown;
};

function droidPatchStatePath(filePath: string): string {
  return `${filePath}.antseed.state.json`;
}

function readDroidPatchState(filePath: string): DroidPatchState | null {
  const state = tryReadConfigPatchFile(droidPatchStatePath(filePath));
  if (!state) return null;
  if ((state['version'] !== 1 && state['version'] !== 2)
    || typeof state['configExisted'] !== 'boolean'
    || typeof state['customModelsPresent'] !== 'boolean'
    || typeof state['modelPresent'] !== 'boolean'
    || (state['version'] === 2 && (
      typeof state['sessionDefaultSettingsPresent'] !== 'boolean'
      || typeof state['sessionDefaultModelPresent'] !== 'boolean'
    ))) {
    throw new Error(`Invalid Antseed Droid restore state at ${droidPatchStatePath(filePath)}`);
  }
  return {
    version: state['version'],
    configExisted: state['configExisted'],
    customModelsPresent: state['customModelsPresent'],
    modelPresent: state['modelPresent'],
    ...(state['modelPresent'] ? { modelValue: state['modelValue'] } : {}),
    sessionDefaultSettingsPresent: state['version'] === 2 && state['sessionDefaultSettingsPresent'] === true,
    sessionDefaultModelPresent: state['version'] === 2 && state['sessionDefaultModelPresent'] === true,
    ...(state['version'] === 2 && state['sessionDefaultModelPresent']
      ? { sessionDefaultModelValue: state['sessionDefaultModelValue'] }
      : {}),
  };
}

function writeDroidPatchState(filePath: string, state: DroidPatchState): void {
  writeJsonFile(droidPatchStatePath(filePath), {
    version: 2,
    configExisted: state.configExisted,
    customModelsPresent: state.customModelsPresent,
    modelPresent: state.modelPresent,
    ...(state.modelPresent ? { modelValue: state.modelValue } : {}),
    sessionDefaultSettingsPresent: state.sessionDefaultSettingsPresent,
    sessionDefaultModelPresent: state.sessionDefaultModelPresent,
    ...(state.sessionDefaultModelPresent ? { sessionDefaultModelValue: state.sessionDefaultModelValue } : {}),
  });
}

function deleteDroidPatchState(filePath: string): void {
  try {
    unlinkSync(droidPatchStatePath(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function droidCustomModels(config: JsonObject, filePath: string): unknown[] {
  const customModels = config['customModels'];
  if (customModels === undefined) return [];
  if (!Array.isArray(customModels)) {
    throw new Error(`Droid customModels at ${filePath} must be an array`);
  }
  return customModels;
}

function isDroidModel(value: unknown, model: string): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as JsonObject)['model'] === model);
}

function droidSessionDefaultSettings(config: JsonObject, filePath: string): JsonObject | undefined {
  const settings = config['sessionDefaultSettings'];
  if (settings === undefined) return undefined;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Droid sessionDefaultSettings at ${filePath} must be an object`);
  }
  return settings as JsonObject;
}

function applyDroidConfigPatch(patch: DroidConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'droid') {
    applyDroidModelToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'droid',
    native: { configPath: filePath },
    posix: { configPath: patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyDroidModelToFile(paths.configPath, patch, url),
  });
}

function applyDroidModelToFile(filePath: string, patch: DroidConfigPatchDef, baseURL: string): void {
  const configExisted = existsSync(filePath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const customModelsPresent = Object.prototype.hasOwnProperty.call(config, 'customModels');
  const customModels = droidCustomModels(config, filePath);
  const existingSessionDefaultSettings = droidSessionDefaultSettings(config, filePath);
  const state = readDroidPatchState(filePath);
  const matchingModels = customModels.filter((model) => isDroidModel(model, patch.providerKey));
  if (matchingModels.length > 0 && !state) {
    throw new Error(
      `Droid already defines a custom model named ${patch.providerKey} in ${filePath}; refusing to overwrite it.`,
    );
  }
  if (!state) {
    const modelPresent = Object.prototype.hasOwnProperty.call(config, 'model');
    const sessionDefaultSettingsPresent = existingSessionDefaultSettings !== undefined;
    const sessionDefaultModelPresent = existingSessionDefaultSettings !== undefined
      && Object.prototype.hasOwnProperty.call(existingSessionDefaultSettings, 'model');
    writeDroidPatchState(filePath, {
      version: 2,
      configExisted,
      customModelsPresent,
      modelPresent,
      ...(modelPresent ? { modelValue: config['model'] } : {}),
      sessionDefaultSettingsPresent,
      sessionDefaultModelPresent,
      ...(sessionDefaultModelPresent
        ? { sessionDefaultModelValue: existingSessionDefaultSettings['model'] }
        : {}),
    });
  }

  const extraHeaders = patch.originator ? { originator: patch.originator } : {};
  config['customModels'] = [
    ...customModels.filter((model) => !isDroidModel(model, patch.providerKey)),
    {
      model: patch.providerKey,
      id: DROID_ROUTED_MODEL_ID,
      displayName: patch.providerName,
      baseUrl: baseURL,
      provider: 'generic-chat-completion-api',
      maxOutputTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    },
  ];
  const sessionDefaultSettings = existingSessionDefaultSettings ?? {};
  sessionDefaultSettings['model'] = DROID_ROUTED_MODEL_ID;
  config['sessionDefaultSettings'] = sessionDefaultSettings;
  writeJsonFile(filePath, config);
}

function removeDroidConfigPatch(patch: DroidConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeDroidModelFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'droid') {
    changed = removeWslInstalls('droid', wslTargetsFile, (target) => (
      removeDroidModelFromFile(target.configPath, patch)
    )) || changed;
  }
  return changed;
}

function removeDroidModelFromFile(filePath: string, patch: DroidConfigPatchDef): boolean {
  const state = readDroidPatchState(filePath);
  if (!state) return false;
  const config = tryReadConfigPatchFile(filePath);
  if (!config) {
    deleteDroidPatchState(filePath);
    return true;
  }
  backupConfigFile(filePath);

  let changed = false;
  const customModels = config['customModels'];
  if (Array.isArray(customModels)) {
    const filtered = customModels.filter((model) => !isDroidModel(model, patch.providerKey));
    if (filtered.length !== customModels.length) {
      if (filtered.length === 0 && !state.customModelsPresent) delete config['customModels'];
      else config['customModels'] = filtered;
      changed = true;
    }
  }
  const sessionDefaultSettings = droidSessionDefaultSettings(config, filePath);
  const managedSessionDefault = sessionDefaultSettings?.['model'] === DROID_ROUTED_MODEL_ID;
  if (managedSessionDefault && sessionDefaultSettings) {
    if (state.sessionDefaultModelPresent) {
      sessionDefaultSettings['model'] = state.sessionDefaultModelValue;
    } else {
      delete sessionDefaultSettings['model'];
    }
    if (!state.sessionDefaultSettingsPresent && Object.keys(sessionDefaultSettings).length === 0) {
      delete config['sessionDefaultSettings'];
    }
    changed = true;
  }
  const modelPresent = Object.prototype.hasOwnProperty.call(config, 'model');
  if (config['model'] === patch.providerKey || (managedSessionDefault && !modelPresent && state.modelPresent)) {
    if (state.modelPresent) config['model'] = state.modelValue;
    else delete config['model'];
    changed = true;
  }

  if (!state.configExisted && Object.keys(config).length === 0) {
    unlinkSync(filePath);
  } else if (changed) {
    writeJsonFile(filePath, config);
  }
  deleteDroidPatchState(filePath);
  return changed;
}

// --- Codex CLI (`~/.codex/config.toml`) ---
//
// Codex config is TOML, edited structurally instead of parsed: the managed
// `[model_providers.<key>]` table is replaced wholesale and the top-level
// `model_provider` / `model` keys are set in the region before the first
// table header (TOML requires top-level keys there). Everything the user
// wrote is left untouched.

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function firstTomlTableIndex(lines: readonly string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

function isCodexProviderTableHeader(line: string, providerKey: string): boolean {
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

function readTomlTopLevelString(lines: readonly string[], key: string): string | undefined {
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index === -1) return undefined;
  const match = lines[index]!.match(/=\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$/);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : undefined;
}

function removeTomlTopLevelKey(lines: readonly string[], key: string): string[] {
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index === -1) return [...lines];
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

function applyCodexConfigPatch(patch: CodexConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'codex') {
    applyCodexProviderToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'codex',
    native: { configPath: filePath },
    posix: { configPath: patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyCodexProviderToFile(paths.configPath, patch, url),
  });
}

function applyCodexProviderToFile(filePath: string, patch: CodexConfigPatchDef, baseURL: string): void {
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  lines = removeCodexProviderTable(lines, patch.providerKey).lines;
  lines = setTomlTopLevelString(lines, 'model_provider', patch.providerKey);
  lines = setTomlTopLevelString(lines, 'model', ROUTED_MODEL_ALIAS);
  lines = setTomlTopLevelValue(lines, 'model_context_window', String(ANTSEED_MODEL_CONTEXT_WINDOW));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines.push(
    '',
    `[model_providers.${patch.providerKey}]`,
    `name = ${tomlBasicString(patch.providerName)}`,
    `base_url = ${tomlBasicString(baseURL)}`,
    // The only wire API Codex still supports; no env_key means Codex sends no
    // Authorization header, which the keyless buyer proxy expects.
    'wire_api = "responses"',
  );
  writeTextFile(filePath, `${lines.join('\n')}\n`);
}

function removeCodexConfigPatch(patch: CodexConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeCodexProviderFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'codex') {
    changed = removeWslInstalls('codex', wslTargetsFile, (target) => removeCodexProviderFromFile(target.configPath, patch)) || changed;
  }
  return changed;
}

function removeCodexProviderFromFile(filePath: string, patch: CodexConfigPatchDef): boolean {
  if (!existsSync(filePath)) return false;
  const raw = readFileSync(filePath, 'utf8');
  const removal = removeCodexProviderTable(raw.split('\n'), patch.providerKey);
  let lines = removal.lines;
  let changed = removal.changed;
  if (readTomlTopLevelString(lines, 'model_provider') === patch.providerKey) {
    lines = removeTomlTopLevelKey(lines, 'model_provider');
    lines = removeTomlTopLevelKey(lines, 'model');
    lines = removeTomlTopLevelKey(lines, 'model_context_window');
    changed = true;
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  writeTextFile(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return true;
}

// --- pi (`~/.pi/agent/models.json` + `~/.pi/agent/settings.json`) ---
//
// pi discovers custom providers from models.json and picks the default
// provider/model from settings.json. The apiKey is a placeholder — the buyer
// proxy is keyless, but pi hides models that have no credential at all.

function applyPiConfigPatch(patch: PiConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  const native = { configPath: expandTilde(patch.configPath), settingsPath: expandTilde(patch.settingsPath) };
  if (!patch.installProbe) {
    applyPiProviderToFiles(native.configPath, native.settingsPath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: patch.installProbe,
    native,
    posix: { configPath: patch.configPath, settingsPath: patch.settingsPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyPiProviderToFiles(paths.configPath, paths.settingsPath ?? native.settingsPath, patch, url),
  });
}

function applyPiProviderToFiles(modelsPath: string, settingsPath: string, patch: PiConfigPatchDef, baseURL: string): void {
  backupConfigFile(modelsPath);
  const config = readConfigPatchFile(modelsPath);
  const providers = (config['providers'] && typeof config['providers'] === 'object' && !Array.isArray(config['providers']))
    ? config['providers'] as JsonObject
    : {};
  providers[patch.providerKey] = {
    baseUrl: baseURL,
    api: patch.api,
    apiKey: 'antseed',
    ...(patch.originator ? { headers: { originator: patch.originator } } : {}),
    models: [
      {
        id: ROUTED_MODEL_ALIAS,
        name: ROUTED_MODEL_ALIAS_LABEL,
        contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW,
        maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      },
    ],
  };
  config['providers'] = providers;
  writeJsonFile(modelsPath, config);

  backupConfigFile(settingsPath);
  const settings = readConfigPatchFile(settingsPath);
  settings['defaultProvider'] = patch.providerKey;
  settings['defaultModel'] = ROUTED_MODEL_ALIAS;
  writeJsonFile(settingsPath, settings);
}

function removePiConfigPatch(patch: PiConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removePiProviderFromFiles(expandTilde(patch.configPath), expandTilde(patch.settingsPath), patch);
  if (patch.installProbe) {
    changed = removeWslInstalls(patch.installProbe, wslTargetsFile, (target) =>
      removePiProviderFromFiles(target.configPath, target.settingsPath ?? '', patch)) || changed;
  }
  return changed;
}

function removePiProviderFromFiles(modelsPath: string, settingsPath: string, patch: PiConfigPatchDef): boolean {
  let changed = false;
  const config = tryReadConfigPatchFile(modelsPath);
  const providers = config?.['providers'];
  if (config && providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    backupConfigFile(modelsPath);
    delete (providers as JsonObject)[patch.providerKey];
    writeJsonFile(modelsPath, config);
    changed = true;
  }
  const settings = tryReadConfigPatchFile(settingsPath);
  if (settings && settings['defaultProvider'] === patch.providerKey) {
    backupConfigFile(settingsPath);
    delete settings['defaultProvider'];
    delete settings['defaultModel'];
    writeJsonFile(settingsPath, settings);
    changed = true;
  }
  return changed;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

// --- Crush (`~/.config/crush/crush.json`) ---
//
// Crush takes custom endpoints as a `providers` map entry with
// `type: "openai-compat"`; the default model selection lives under
// `models.large` / `models.small` as `{ provider, model }`.

function applyCrushConfigPatch(patch: CrushConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'crush') {
    applyCrushProviderToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'crush',
    native: { configPath: filePath },
    posix: { configPath: patch.wslConfigPath ?? patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyCrushProviderToFile(paths.configPath, patch, url),
  });
}

function applyCrushProviderToFile(filePath: string, patch: CrushConfigPatchDef, baseURL: string): void {
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const providers = asObject(config['providers']);
  providers[patch.providerKey] = {
    type: 'openai-compat',
    name: patch.providerName,
    base_url: baseURL,
    api_key: 'antseed',
    models: [
      { id: ROUTED_MODEL_ALIAS, name: ROUTED_MODEL_ALIAS_LABEL, context_window: ANTSEED_MODEL_CONTEXT_WINDOW, default_max_tokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
    ],
  };
  config['providers'] = providers;
  const models = asObject(config['models']);
  const selection = { provider: patch.providerKey, model: ROUTED_MODEL_ALIAS };
  models['large'] = { ...selection };
  models['small'] = { ...selection };
  config['models'] = models;
  writeJsonFile(filePath, config);
}

function removeCrushConfigPatch(patch: CrushConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeCrushProviderFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'crush') {
    changed = removeWslInstalls('crush', wslTargetsFile, (target) => removeCrushProviderFromFile(target.configPath, patch)) || changed;
  }
  return changed;
}

function removeCrushProviderFromFile(filePath: string, patch: CrushConfigPatchDef): boolean {
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  let changed = false;
  const providers = config['providers'];
  if (providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    delete (providers as JsonObject)[patch.providerKey];
    changed = true;
  }
  const models = config['models'];
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    for (const size of ['large', 'small']) {
      const entry = (models as JsonObject)[size];
      if (entry && typeof entry === 'object' && (entry as JsonObject)['provider'] === patch.providerKey) {
        delete (models as JsonObject)[size];
        changed = true;
      }
    }
    if (Object.keys(models as JsonObject).length === 0) delete config['models'];
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  writeJsonFile(filePath, config);
  return true;
}

// --- goose (`~/.config/goose/config.yaml`) ---
//
// goose config is flat env-style YAML keys (GOOSE_PROVIDER, GOOSE_MODEL,
// OPENAI_HOST, ...), edited line-based so user keys and comments survive.
// OPENAI_HOST is the host root — goose appends the /v1 chat path itself.
// The api key normally lives in the OS keyring; the config-file value covers
// keyring-less setups, and the buyer proxy ignores the credential anyway.

function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlTopLevelKeyIndex(lines: readonly string[], key: string): number {
  const pattern = new RegExp(`^${key}\\s*:`);
  return lines.findIndex((line) => pattern.test(line));
}

function setYamlTopLevelString(lines: readonly string[], key: string, value: string): string[] {
  const assignment = `${key}: ${yamlScalar(value)}`;
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index !== -1) {
    const next = [...lines];
    next[index] = assignment;
    return next;
  }
  return [...lines, assignment];
}

function readYamlTopLevelString(lines: readonly string[], key: string): string | undefined {
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index === -1) return undefined;
  const raw = lines[index]!.slice(lines[index]!.indexOf(':') + 1).trim();
  const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"/) ?? raw.match(/^'([^']*)'/);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, '$1');
  return raw.split('#')[0]!.trim();
}

function removeYamlTopLevelKey(lines: readonly string[], key: string): string[] {
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index === -1) return [...lines];
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

/** True for host values only this patch would have written: a loopback root,
    or one of the WSL-reachable hosts a recorded target carries. */
function isLoopbackHost(value: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (!value) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(value)) return true;
  return extraHosts.some((host) =>
    new RegExp(`^https?://${host.replace(/[.$]/g, '\\$&')}:\\d+/?$`).test(value));
}

function applyGooseConfigPatch(patch: GooseConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'goose') {
    applyGooseProviderToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'goose',
    native: { configPath: filePath },
    posix: { configPath: patch.wslConfigPath ?? patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyGooseProviderToFile(paths.configPath, patch, url),
  });
}

function applyGooseProviderToFile(filePath: string, patch: GooseConfigPatchDef, baseURL: string): void {
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines = setYamlTopLevelString(lines, 'GOOSE_PROVIDER', patch.providerKey);
  lines = setYamlTopLevelString(lines, 'GOOSE_MODEL', ROUTED_MODEL_ALIAS);
  lines = setYamlTopLevelString(lines, 'OPENAI_HOST', baseURL);
  lines = setYamlTopLevelString(lines, 'OPENAI_API_KEY', 'antseed');
  writeTextFile(filePath, `${lines.join('\n')}\n`);
}

function removeGooseConfigPatch(patch: GooseConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeGooseProviderFromFile(expandTilde(patch.configPath), patch, []);
  if (patch.installProbe === 'goose') {
    // The WSL config carries the gateway address rather than a loopback
    // host, so the recorded host joins the ownership check.
    changed = removeWslInstalls('goose', wslTargetsFile, (target) => removeGooseProviderFromFile(target.configPath, patch, [target.host])) || changed;
  }
  return changed;
}

function removeGooseProviderFromFile(filePath: string, patch: GooseConfigPatchDef, extraHosts: readonly string[]): boolean {
  if (!existsSync(filePath)) return false;
  let lines = readFileSync(filePath, 'utf8').split('\n');
  let changed = false;
  if (isLoopbackHost(readYamlTopLevelString(lines, 'OPENAI_HOST'), extraHosts)) {
    lines = removeYamlTopLevelKey(lines, 'OPENAI_HOST');
    changed = true;
  }
  if (readYamlTopLevelString(lines, 'OPENAI_API_KEY') === 'antseed') {
    lines = removeYamlTopLevelKey(lines, 'OPENAI_API_KEY');
    changed = true;
  }
  const model = readYamlTopLevelString(lines, 'GOOSE_MODEL');
  const ownsModel = model === ROUTED_MODEL_ALIAS || (model?.includes('@') ?? false);
  if (readYamlTopLevelString(lines, 'GOOSE_PROVIDER') === patch.providerKey && ownsModel) {
    lines = removeYamlTopLevelKey(lines, 'GOOSE_PROVIDER');
    lines = removeYamlTopLevelKey(lines, 'GOOSE_MODEL');
    changed = true;
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  writeTextFile(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return true;
}

// --- Hermes Agent (`~/.hermes/config.yaml`) ---

function readHermesConfigDocument(filePath: string): Document.Parsed {
  const document = existsSync(filePath)
    ? parseDocument(readFileSync(filePath, 'utf8'))
    : parseDocument('{}\n');
  if (document.errors.length > 0) {
    throw new Error(`Unable to parse Hermes config: ${document.errors[0]!.message}`);
  }
  return document;
}

function writeHermesConfigDocument(filePath: string, document: Document.Parsed): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, document.toString(), 'utf8');
}

function applyHermesConfigPatch(patch: HermesConfigPatchDef, buyerPort: number): void {
  const filePath = expandTilde(patch.configPath);
  const document = readHermesConfigDocument(filePath);
  backupConfigFile(filePath);
  document.setIn(['providers', patch.providerKey], {
    name: 'Antseed',
    api: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
    transport: 'chat_completions',
    extra_headers: {
      originator: 'hermes',
    },
    default_model: ROUTED_MODEL_ALIAS,
    models: {
      [ROUTED_MODEL_ALIAS]: {
        context_length: ANTSEED_MODEL_CONTEXT_WINDOW,
      },
    },
  });
  document.setIn(['model', 'provider'], patch.providerKey);
  document.setIn(['model', 'default'], ROUTED_MODEL_ALIAS);
  document.setIn(['model', 'base_url'], '');
  document.setIn(['model', 'api_mode'], 'chat_completions');
  writeHermesConfigDocument(filePath, document);
}

function removeHermesConfigPatch(patch: HermesConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  if (!existsSync(filePath)) return false;
  const document = readHermesConfigDocument(filePath);
  const providerApi = document.getIn(['providers', patch.providerKey, 'api']);
  if (typeof providerApi !== 'string' || !/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/v1\/?$/.test(providerApi)) {
    return false;
  }

  let changed = document.deleteIn(['providers', patch.providerKey]);
  if (document.getIn(['model', 'provider']) === patch.providerKey) {
    changed = document.deleteIn(['model', 'provider']) || changed;
    changed = document.deleteIn(['model', 'default']) || changed;
    changed = document.deleteIn(['model', 'base_url']) || changed;
    changed = document.deleteIn(['model', 'api_mode']) || changed;
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  writeHermesConfigDocument(filePath, document);
  return true;
}

// --- Zed (`~/.config/zed/settings.json`) ---
//
// Zed takes custom endpoints under `language_models.openai_compatible`,
// keyed by provider name; the agent's default model references that name.
// Zed asks for the provider's API key once in its UI — any value satisfies
// the keyless buyer proxy.

function applyZedConfigPatch(patch: ZedConfigPatchDef, buyerPort: number): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const languageModels = asObject(config['language_models']);
  const compatible = asObject(languageModels['openai_compatible']);
  compatible[patch.providerName] = {
    api_url: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
    available_models: [
      { name: ROUTED_MODEL_ALIAS, display_name: ROUTED_MODEL_ALIAS_LABEL, max_tokens: ANTSEED_MODEL_CONTEXT_WINDOW },
    ],
  };
  languageModels['openai_compatible'] = compatible;
  config['language_models'] = languageModels;
  const agent = asObject(config['agent']);
  agent['default_model'] = {
    provider: patch.providerName,
    model: ROUTED_MODEL_ALIAS,
  };
  config['agent'] = agent;
  writeJsonFile(filePath, config);
}

function removeZedConfigPatch(patch: ZedConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  let changed = false;
  const languageModels = config['language_models'];
  const compatible = languageModels && typeof languageModels === 'object' && !Array.isArray(languageModels)
    ? (languageModels as JsonObject)['openai_compatible']
    : undefined;
  if (compatible && typeof compatible === 'object' && !Array.isArray(compatible) && (patch.providerName in (compatible as JsonObject))) {
    delete (compatible as JsonObject)[patch.providerName];
    if (Object.keys(compatible as JsonObject).length === 0) {
      delete (languageModels as JsonObject)['openai_compatible'];
      if (Object.keys(languageModels as JsonObject).length === 0) delete config['language_models'];
    }
    changed = true;
  }
  const agent = config['agent'];
  if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
    const defaultModel = (agent as JsonObject)['default_model'];
    if (defaultModel && typeof defaultModel === 'object' && (defaultModel as JsonObject)['provider'] === patch.providerName) {
      delete (agent as JsonObject)['default_model'];
      if (Object.keys(agent as JsonObject).length === 0) delete config['agent'];
      changed = true;
    }
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  writeJsonFile(filePath, config);
  return true;
}

// --- Claude Code CLI (`~/.claude/settings.json`) ---
//
// Claude Code reads gateway settings from its user settings `env` block. The
// sidecar records only the env/model values Antseed replaces so disconnect
// restores the user's prior state without rolling back unrelated settings.

const CLAUDE_CODE_SOURCE = 'claude-code';
const CLAUDE_CODE_SOURCE_HEADER = `x-antseed-system-proxy-source: ${CLAUDE_CODE_SOURCE}`;
const CLAUDE_CODE_MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const;

type ClaudeCodeManagedEnvKey = typeof CLAUDE_CODE_MANAGED_ENV_KEYS[number];

type ClaudeCodeSavedValue = {
  readonly present: boolean;
  readonly value?: unknown;
};

type ClaudeCodePatchState = {
  readonly version: 1;
  readonly configExisted: boolean;
  readonly envPresent: boolean;
  readonly env: Readonly<Record<ClaudeCodeManagedEnvKey, ClaudeCodeSavedValue>>;
  readonly model: ClaudeCodeSavedValue;
};

function claudeCodePatchStatePath(filePath: string): string {
  return `${filePath}.antseed.state.json`;
}

function savedValue(source: JsonObject, key: string): ClaudeCodeSavedValue {
  return Object.prototype.hasOwnProperty.call(source, key)
    ? { present: true, value: source[key] }
    : { present: false };
}

function readSavedValue(raw: unknown, statePath: string, key: string): ClaudeCodeSavedValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as JsonObject)['present'] !== 'boolean') {
    throw new Error(`Invalid Antseed Claude Code restore value ${key} at ${statePath}`);
  }
  const value = raw as JsonObject;
  return value['present'] ? { present: true, value: value['value'] } : { present: false };
}

function readClaudeCodePatchState(filePath: string): ClaudeCodePatchState | null {
  const statePath = claudeCodePatchStatePath(filePath);
  const state = tryReadConfigPatchFile(statePath);
  if (!state) return null;
  const env = state['env'];
  if (state['version'] !== 1
    || typeof state['configExisted'] !== 'boolean'
    || typeof state['envPresent'] !== 'boolean'
    || !env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`Invalid Antseed Claude Code restore state at ${statePath}`);
  }
  const savedEnv = Object.fromEntries(CLAUDE_CODE_MANAGED_ENV_KEYS.map((key) => [
    key,
    readSavedValue((env as JsonObject)[key], statePath, key),
  ])) as Record<ClaudeCodeManagedEnvKey, ClaudeCodeSavedValue>;
  return {
    version: 1,
    configExisted: state['configExisted'],
    envPresent: state['envPresent'],
    env: savedEnv,
    model: readSavedValue(state['model'], statePath, 'model'),
  };
}

function writeClaudeCodePatchState(filePath: string, state: ClaudeCodePatchState): void {
  writeJsonFile(claudeCodePatchStatePath(filePath), state as unknown as JsonObject);
}

function deleteClaudeCodePatchState(filePath: string): void {
  try {
    unlinkSync(claudeCodePatchStatePath(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function claudeCodeEnv(config: JsonObject, filePath: string): JsonObject | undefined {
  const env = config['env'];
  if (env === undefined) return undefined;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`Claude Code env at ${filePath} must be an object`);
  }
  return env as JsonObject;
}

function applyClaudeCodeConfigPatch(patch: ClaudeCodeConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'claude') {
    applyClaudeCodeSettingsToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'claude',
    native: { configPath: filePath },
    posix: { configPath: patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyClaudeCodeSettingsToFile(paths.configPath, patch, url),
  });
}

function applyClaudeCodeSettingsToFile(filePath: string, patch: ClaudeCodeConfigPatchDef, baseURL: string): void {
  const configExisted = existsSync(filePath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const existingEnv = claudeCodeEnv(config, filePath);
  if (!readClaudeCodePatchState(filePath)) {
    const envSource = existingEnv ?? {};
    writeClaudeCodePatchState(filePath, {
      version: 1,
      configExisted,
      envPresent: existingEnv !== undefined,
      env: Object.fromEntries(CLAUDE_CODE_MANAGED_ENV_KEYS.map((key) => [key, savedValue(envSource, key)])) as Record<ClaudeCodeManagedEnvKey, ClaudeCodeSavedValue>,
      model: savedValue(config, 'model'),
    });
  }

  const env = existingEnv ?? {};
  env['ANTHROPIC_BASE_URL'] = baseURL;
  env['ANTHROPIC_AUTH_TOKEN'] = patch.providerKey;
  env['ANTHROPIC_API_KEY'] = '';
  env['ANTHROPIC_CUSTOM_HEADERS'] = CLAUDE_CODE_SOURCE_HEADER;
  config['env'] = env;
  config['model'] = ROUTED_MODEL_ALIAS;
  writeJsonFile(filePath, config);
}

function removeClaudeCodeConfigPatch(patch: ClaudeCodeConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeClaudeCodeSettingsFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'claude') {
    changed = removeWslInstalls('claude', wslTargetsFile, (target) => (
      removeClaudeCodeSettingsFromFile(target.configPath, patch, [target.host])
    )) || changed;
  }
  return changed;
}

function restoreSavedValue(target: JsonObject, key: string, saved: ClaudeCodeSavedValue): void {
  if (saved.present) target[key] = saved.value;
  else delete target[key];
}

function removeClaudeCodeSettingsFromFile(
  filePath: string,
  patch: ClaudeCodeConfigPatchDef,
  extraHosts: readonly string[] = [],
): boolean {
  const state = readClaudeCodePatchState(filePath);
  if (!state) return false;
  const config = tryReadConfigPatchFile(filePath);
  if (!config) {
    deleteClaudeCodePatchState(filePath);
    return true;
  }
  backupConfigFile(filePath);

  let changed = false;
  const env = claudeCodeEnv(config, filePath);
  if (env) {
    const managedValues: Record<ClaudeCodeManagedEnvKey, unknown> = {
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: patch.providerKey,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: CLAUDE_CODE_SOURCE_HEADER,
    };
    for (const key of CLAUDE_CODE_MANAGED_ENV_KEYS) {
      const value = env[key];
      const managed = key === 'ANTHROPIC_BASE_URL'
        ? typeof value === 'string' && isLoopbackHost(value, extraHosts)
        : value === managedValues[key];
      if (!managed) continue;
      restoreSavedValue(env, key, state.env[key]);
      changed = true;
    }
    if (!state.envPresent && Object.keys(env).length === 0) delete config['env'];
  }
  if (config['model'] === ROUTED_MODEL_ALIAS) {
    restoreSavedValue(config, 'model', state.model);
    changed = true;
  }

  if (!state.configExisted && Object.keys(config).length === 0) {
    unlinkSync(filePath);
  } else if (changed) {
    writeJsonFile(filePath, config);
  }
  deleteClaudeCodePatchState(filePath);
  return changed;
}

function applyT3CodeConfigPatch(patch: T3CodeConfigPatchDef, buyerPort: number): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const providerInstances = asObject(config['providerInstances']);
  const customModels = [ROUTED_MODEL_ALIAS];
  providerInstances[patch.providerKey] = {
    driver: 'claudeAgent',
    displayName: patch.providerName,
    environment: [
      { name: 'ANTHROPIC_BASE_URL', value: patch.baseURL.replace('{buyerPort}', String(buyerPort)), sensitive: false },
      { name: 'ANTHROPIC_API_KEY', value: 'antseed', sensitive: false },
      { name: 'ANTHROPIC_CUSTOM_HEADERS', value: 'x-antseed-system-proxy-source: t3code', sensitive: false },
      { name: 'HTTP_PROXY', value: '', sensitive: false },
      { name: 'HTTPS_PROXY', value: '', sensitive: false },
      { name: 'http_proxy', value: '', sensitive: false },
      { name: 'https_proxy', value: '', sensitive: false },
      { name: 'NO_PROXY', value: 'localhost,127.0.0.1,::1', sensitive: false },
      { name: 'no_proxy', value: 'localhost,127.0.0.1,::1', sensitive: false },
      { name: 'NODE_OPTIONS', value: '', sensitive: false },
    ],
    enabled: true,
    config: { customModels },
  };
  config['providerInstances'] = providerInstances;
  writeJsonFile(filePath, config);
}

function removeT3CodeConfigPatch(patch: T3CodeConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  const providerInstances = config['providerInstances'];
  if (!providerInstances || typeof providerInstances !== 'object' || Array.isArray(providerInstances)) return false;
  const instance = (providerInstances as JsonObject)[patch.providerKey];
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return false;
  const environment = (instance as JsonObject)['environment'];
  const ownsInstance = Array.isArray(environment) && environment.some((variable) => {
    if (!variable || typeof variable !== 'object' || Array.isArray(variable)) return false;
    const value = (variable as JsonObject)['value'];
    return (variable as JsonObject)['name'] === 'ANTHROPIC_BASE_URL'
      && isLoopbackHost(typeof value === 'string' ? value : undefined);
  });
  if (!ownsInstance) return false;
  delete (providerInstances as JsonObject)[patch.providerKey];
  if (Object.keys(providerInstances as JsonObject).length === 0) delete config['providerInstances'];
  backupConfigFile(filePath);
  writeJsonFile(filePath, config);
  return true;
}

/** One Claude Desktop install location: the normal-profile config plus the
    third-party profile directory next to it. */
export type ClaudeDesktopPatchTarget = {
  readonly configPath: string;
  readonly thirdPartyDir: string;
};

function claudeDesktopSafeListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Candidate install locations for Claude Desktop, most likely first. macOS
 * has a single documented location (the profile's own paths). Windows varies
 * by installer: `%APPDATA%\Claude` for the classic installer, the MSIX
 * package's virtualized `LocalCache\Roaming\Claude` for Store/winget
 * installs, plus the `%LOCALAPPDATA%` and "Claude Nest" variants Ollama's
 * integration probes. Apply writes the first candidate that exists; remove
 * unwinds every candidate this patch owns. The third-party profile directory
 * is always the sibling `<root>-3p`, mirroring Claude's own 1p/3p layout.
 */
export function claudeDesktopPatchTargets(
  patch: ClaudeDesktopConfigPatchDef,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  listDir: (dir: string) => string[] = claudeDesktopSafeListDir,
): ClaudeDesktopPatchTarget[] {
  if (platform !== 'win32') {
    return [{ configPath: expandTilde(patch.configPath), thirdPartyDir: expandTilde(patch.thirdPartyDir) }];
  }
  const roaming = env['APPDATA'] || path.join(homedir(), 'AppData', 'Roaming');
  const local = env['LOCALAPPDATA'] || path.join(homedir(), 'AppData', 'Local');
  const packagesDir = path.join(local, 'Packages');
  const msixRoots = listDir(packagesDir)
    .filter((name) => name.startsWith('Claude_'))
    .map((name) => path.join(packagesDir, name, 'LocalCache', 'Roaming', 'Claude'));
  const roots = [
    path.join(roaming, 'Claude'),
    ...msixRoots,
    path.join(local, 'Claude'),
    path.join(roaming, 'Claude Nest'),
    path.join(local, 'Claude Nest'),
  ];
  const seen = new Set<string>();
  const targets: ClaudeDesktopPatchTarget[] = [];
  for (const root of roots) {
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      configPath: path.join(root, 'claude_desktop_config.json'),
      thirdPartyDir: `${root}-3p`,
    });
  }
  return targets;
}

type ClaudeDesktopPatchPaths = {
  readonly desktopConfig: string;
  readonly meta: string;
  readonly profile: string;
};

function claudeDesktopPatchPaths(target: ClaudeDesktopPatchTarget): ClaudeDesktopPatchPaths {
  return {
    desktopConfig: path.join(target.thirdPartyDir, 'claude_desktop_config.json'),
    meta: path.join(target.thirdPartyDir, 'configLibrary', '_meta.json'),
    profile: path.join(target.thirdPartyDir, 'configLibrary', `${CLAUDE_DESKTOP_PROFILE_ID}.json`),
  };
}

function claudeDesktopMetaEntries(meta: JsonObject): unknown[] {
  return Array.isArray(meta['entries']) ? meta['entries'] : [];
}

function isOwnClaudeDesktopMetaEntry(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as JsonObject)['id'] === CLAUDE_DESKTOP_PROFILE_ID;
}

function applyClaudeDesktopConfigPatch(patch: ClaudeDesktopConfigPatchDef): void {
  const targets = claudeDesktopPatchTargets(patch);
  const target = targets.find((candidate) => existsSync(path.dirname(candidate.configPath)));
  if (!target) {
    throw new Error(
      'Claude Desktop was not found on this machine — nothing to connect. '
      + `Looked for ${targets.map((candidate) => path.dirname(candidate.configPath)).join(', ')}. `
      + 'Install Claude Desktop (or run it once), then reconnect.',
    );
  }
  const normalConfigPath = target.configPath;
  const gatewayBaseUrl = patch.baseURL.replace('{claudeGatewayPort}', String(CLAUDE_GATEWAY_DEFAULT_PORT));
  const paths = claudeDesktopPatchPaths(target);

  // Claude reads deploymentMode from the normal profile at startup and, when
  // it says '3p', boots against the third-party profile directory instead —
  // the normal profile (login, chats, MCP config) is left as-is.
  backupConfigFile(normalConfigPath);
  const normalConfig = readConfigPatchFile(normalConfigPath);
  normalConfig['deploymentMode'] = '3p';
  writeJsonFile(normalConfigPath, normalConfig);

  const desktopConfig = readConfigPatchFile(paths.desktopConfig);
  desktopConfig['deploymentMode'] = '3p';
  writeJsonFile(paths.desktopConfig, desktopConfig);

  const profile = readConfigPatchFile(paths.profile);
  profile['inferenceProvider'] = 'gateway';
  profile['inferenceGatewayBaseUrl'] = gatewayBaseUrl;
  // The gateway is loopback-only and ignores credentials; Claude just needs a
  // non-empty key for its gateway auth scheme.
  profile['inferenceGatewayApiKey'] = 'antseed';
  profile['inferenceGatewayAuthScheme'] = 'bearer';
  profile['deploymentDisplayName'] = CLAUDE_DESKTOP_PROFILE_NAME;
  profile['chatTabEnabled'] = true;
  profile['disableDeploymentModeChooser'] = true;
  // Cowork needs unrestricted egress for user-configured plugins/MCP servers.
  profile['coworkEgressAllowedHosts'] = ['*'];
  profile['disableEssentialTelemetry'] = true;
  profile['disableNonessentialTelemetry'] = true;
  // Model discovery comes from the gateway's /v1/models — a pinned list here
  // would shadow it.
  delete profile['inferenceModels'];
  // Claude's published model catalog (fetched from downloads.claude.ai on 3p
  // boots) relabels picker entries by id, so "Antseed Auto" behind
  // claude-fable-5 would show as "Fable 5" and every curated slot as the
  // Claude model whose id it borrows. The gateway's display names are the
  // real labels; keep the catalog off so they win.
  profile['modelCatalogEnabled'] = false;
  writeJsonFile(paths.profile, profile);

  const meta = readConfigPatchFile(paths.meta);
  meta['appliedId'] = CLAUDE_DESKTOP_PROFILE_ID;
  meta['entries'] = [
    ...claudeDesktopMetaEntries(meta).filter((entry) => !isOwnClaudeDesktopMetaEntry(entry)),
    { id: CLAUDE_DESKTOP_PROFILE_ID, name: CLAUDE_DESKTOP_PROFILE_NAME },
  ];
  writeJsonFile(paths.meta, meta);
}

function removeClaudeDesktopConfigPatch(patch: ClaudeDesktopConfigPatchDef): boolean {
  // Every candidate root is checked: the install this patch configured may
  // not be the first candidate anymore (e.g. an MSIX Claude installed since).
  let changed = false;
  for (const target of claudeDesktopPatchTargets(patch)) {
    if (removeClaudeDesktopTarget(target)) changed = true;
  }
  return changed;
}

function removeClaudeDesktopTarget(target: ClaudeDesktopPatchTarget): boolean {
  const paths = claudeDesktopPatchPaths(target);
  const meta = tryReadConfigPatchFile(paths.meta);
  const profile = tryReadConfigPatchFile(paths.profile);
  // Only unwind a third-party setup this patch created: our profile file
  // pointing at a loopback gateway, or the configLibrary applying our entry.
  // An enterprise/MDM-provisioned 3p profile must keep its deployment mode.
  const gatewayUrl = profile && typeof profile['inferenceGatewayBaseUrl'] === 'string'
    ? profile['inferenceGatewayBaseUrl']
    : undefined;
  const ownsProfileFile = profile?.['inferenceProvider'] === 'gateway' && isLoopbackHost(gatewayUrl);
  const ownsSetup = ownsProfileFile
    || meta?.['appliedId'] === CLAUDE_DESKTOP_PROFILE_ID
    || claudeDesktopMetaEntries(meta ?? {}).some(isOwnClaudeDesktopMetaEntry);
  if (!ownsSetup) return false;

  let changed = false;
  for (const configPath of [target.configPath, paths.desktopConfig]) {
    const config = tryReadConfigPatchFile(configPath);
    if (config && config['deploymentMode'] === '3p') {
      config['deploymentMode'] = '1p';
      writeJsonFile(configPath, config);
      changed = true;
    }
  }
  if (meta) {
    let metaChanged = false;
    if (meta['appliedId'] === CLAUDE_DESKTOP_PROFILE_ID) {
      delete meta['appliedId'];
      metaChanged = true;
    }
    const entries = claudeDesktopMetaEntries(meta);
    const filtered = entries.filter((entry) => !isOwnClaudeDesktopMetaEntry(entry));
    if (filtered.length !== entries.length) {
      meta['entries'] = filtered;
      metaChanged = true;
    }
    if (metaChanged) {
      writeJsonFile(paths.meta, meta);
      changed = true;
    }
  }
  if (profile && ownsProfileFile) {
    for (const key of [
      'inferenceProvider',
      'inferenceGatewayBaseUrl',
      'inferenceGatewayApiKey',
      'inferenceGatewayAuthScheme',
      'deploymentDisplayName',
      'coworkEgressAllowedHosts',
      'disableEssentialTelemetry',
      'disableNonessentialTelemetry',
      'inferenceModels',
    ]) {
      delete profile[key];
    }
    profile['disableDeploymentModeChooser'] = false;
    writeJsonFile(paths.profile, profile);
    changed = true;
  }
  return changed;
}

// --- Read-only inspection (used by `antseed apps status`) ---
//
// Mirrors the ownership checks the remove paths use, without writing
// anything: "connected" means the config currently carries the entry
// AntSeed would remove on disconnect.

/** Absolute (tilde-expanded) native config paths a patch touches. */
export function configPatchPaths(patch: ConfigPatchDef): string[] {
  if (patch.format === 'claude-desktop') {
    return claudeDesktopPatchTargets(patch).map((target) => target.configPath);
  }
  if (patch.format === 'pi') return [expandTilde(patch.configPath), expandTilde(patch.settingsPath)];
  return [expandTilde(patch.configPath)];
}

function patchInstallProbe(patch: ConfigPatchDef): WslTool | undefined {
  const probe = (patch as { installProbe?: unknown }).installProbe;
  return typeof probe === 'string' && probe in WSL_TOOL_PROBES ? probe as WslTool : undefined;
}

/**
 * Whether the tool looks present on this machine. Install-probed profiles use
 * the same native signals connect uses (config dir, home install locations,
 * binary on PATH) plus WSL targets recorded by an earlier connect — WSL
 * discovery itself is skipped because it would cold-start distros. Other
 * profiles count as installed when their config directory exists.
 */
export function isConfigPatchInstalled(patch: ConfigPatchDef, wslTargetsFile?: string): boolean {
  const probe = patchInstallProbe(patch);
  if (probe) {
    if (nativeToolInstalled(probe, expandTilde(patch.configPath))) return true;
    return wslTargetsFile ? readWslTargetsForTool(wslTargetsFile, probe).length > 0 : false;
  }
  return configPatchPaths(patch).some((filePath) => existsSync(path.dirname(filePath)));
}

/** Whether the tool's config currently carries AntSeed's managed entry. */
export function isConfigPatchConnected(patch: ConfigPatchDef, wslTargetsFile?: string): boolean {
  const probe = patchInstallProbe(patch);
  if (probe && wslTargetsFile && readWslTargetsForTool(wslTargetsFile, probe).length > 0) return true;
  try {
    return nativeConfigPatchConnected(patch);
  } catch {
    // An unparseable config cannot be carrying a working AntSeed entry.
    return false;
  }
}

function nativeConfigPatchConnected(patch: ConfigPatchDef): boolean {
  if (patch.format === 'claude-desktop') {
    return claudeDesktopPatchTargets(patch).some((target) => {
      const paths = claudeDesktopPatchPaths(target);
      const meta = tryReadConfigPatchFile(paths.meta);
      const profile = tryReadConfigPatchFile(paths.profile);
      const gatewayUrl = typeof profile?.['inferenceGatewayBaseUrl'] === 'string'
        ? profile['inferenceGatewayBaseUrl']
        : undefined;
      return meta?.['appliedId'] === CLAUDE_DESKTOP_PROFILE_ID
        || (profile?.['inferenceProvider'] === 'gateway' && isLoopbackHost(gatewayUrl));
    });
  }
  const filePath = expandTilde(patch.configPath);
  if (patch.format === 'droid') return existsSync(droidPatchStatePath(filePath));
  if (patch.format === 'claude-code') return existsSync(claudeCodePatchStatePath(filePath));
  if (patch.format === 'codex') {
    if (!existsSync(filePath)) return false;
    const lines = readFileSync(filePath, 'utf8').split('\n');
    return lines.some((line) => isCodexProviderTableHeader(line, patch.providerKey))
      || readTomlTopLevelString(lines, 'model_provider') === patch.providerKey;
  }
  if (patch.format === 'goose') {
    if (!existsSync(filePath)) return false;
    const lines = readFileSync(filePath, 'utf8').split('\n');
    return readYamlTopLevelString(lines, 'GOOSE_PROVIDER') === patch.providerKey
      && readYamlTopLevelString(lines, 'GOOSE_MODEL') === ROUTED_MODEL_ALIAS;
  }
  if (patch.format === 'hermes') {
    if (!existsSync(filePath)) return false;
    const providerApi = readHermesConfigDocument(filePath).getIn(['providers', patch.providerKey, 'api']);
    return typeof providerApi === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+\/v1\/?$/.test(providerApi);
  }
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  if (patch.format === 'pi' || patch.format === 'crush') {
    return patch.providerKey in asObject(config['providers']);
  }
  if (patch.format === 'zed') {
    return patch.providerName in asObject(asObject(config['language_models'])['openai_compatible']);
  }
  if (patch.format === 't3code') {
    const instance = asObject(asObject(config['providerInstances'])[patch.providerKey]);
    const environment = instance['environment'];
    return Array.isArray(environment) && environment.some((variable) => {
      const entry = asObject(variable);
      return entry['name'] === 'ANTHROPIC_BASE_URL'
        && isLoopbackHost(typeof entry['value'] === 'string' ? entry['value'] : undefined);
    });
  }
  return patch.providerKey in asObject(config['provider']);
}
