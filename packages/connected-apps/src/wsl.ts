/**
 * WSL support for config-patch connections on Windows.
 *
 * A tool living inside a WSL distro reads neither the Windows-side config
 * file nor — under WSL2's default NAT networking — the Windows loopback the
 * buyer proxy listens on. This module finds the distros that actually have
 * the tool installed, maps the tool's config path into each distro through
 * the `\\wsl.localhost\` UNC share, and works out which host the distro can
 * reach the Windows buyer proxy on: `localhost` under mirrored networking,
 * otherwise the distro's default-route gateway (the Windows host's vEthernet
 * address). NAT targets additionally need the relay in the desktop's system-proxy/wsl-relay.ts, because
 * the buyer proxy itself only binds 127.0.0.1.
 *
 * Electron-free on purpose (like config-patch.ts) so tests can drive it; the
 * persisted-targets file path is always passed in by the caller.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Per-tool install signals: the binary name, plus `$HOME`-relative paths the
 * tool's installer or first run creates. The paths matter because a plain
 * `sh` in a distro has no login-shell PATH, so `command -v` misses installs
 * living in `~/.opencode/bin`, `~/.local/bin`, and friends.
 */
export const WSL_TOOL_PROBES = {
  opencode: { binary: 'opencode', signals: ['.opencode/bin/opencode', '.local/bin/opencode', '.config/opencode', '.local/share/opencode'] },
  codex: { binary: 'codex', signals: ['.codex', '.local/bin/codex'] },
  claude: { binary: 'claude', signals: ['.claude', '.local/bin/claude', '.claude/local/claude'] },
  droid: { binary: 'droid', signals: ['.factory', '.factory/bin/droid', '.local/bin/droid'] },
  crush: { binary: 'crush', signals: ['.config/crush', '.local/share/crush', '.local/bin/crush'] },
  goose: { binary: 'goose', signals: ['.config/goose', '.local/bin/goose'] },
  pi: { binary: 'pi', signals: ['.pi', '.local/bin/pi'] },
  'prime-agent': { binary: 'prime-agent', signals: ['.prime/agent', '.local/bin/prime-agent'] },
} as const;

export type WslTool = keyof typeof WSL_TOOL_PROBES;

export function isWslTool(value: unknown): value is WslTool {
  return typeof value === 'string' && value in WSL_TOOL_PROBES;
}

export type WslConfigTarget = {
  /** Which tool's config this row belongs to (the profile's installProbe). */
  readonly tool: WslTool;
  readonly distro: string;
  /** UNC path of the tool's config file inside the distro. */
  readonly configPath: string;
  /** UNC path of the tool's secondary settings file (pi-format tools only). */
  readonly settingsPath?: string;
  /** Host on which the distro reaches the Windows-side buyer proxy. */
  readonly host: string;
  /** True when a relay must listen on `host` — NAT mode, where the buyer
      proxy's 127.0.0.1 listener is unreachable from inside the distro. */
  readonly needsRelay: boolean;
};

/** Utility distros that never carry user tooling — not worth cold-starting. */
const IGNORED_DISTROS = /^(docker-desktop|docker-desktop-data|rancher-desktop|rancher-desktop-data|podman-machine)/i;

const WSL_EXEC_TIMEOUT_MS = 30_000;

function runWsl(args: readonly string[]): Buffer | null {
  try {
    return execFileSync('wsl.exe', [...args], {
      timeout: WSL_EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * `wsl.exe` management output is UTF-16LE unless WSL_UTF8=1 is set in the
 * environment; NUL bytes in the buffer are the tell.
 */
export function decodeWslOutput(output: Buffer): string {
  const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

export function parseWslDistroList(output: Buffer): string[] {
  return decodeWslOutput(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !IGNORED_DISTROS.test(line));
}

export function listWslDistros(): string[] {
  if (process.platform !== 'win32') return [];
  const output = runWsl(['--list', '--quiet']);
  return output ? parseWslDistroList(output) : [];
}

export function parseDefaultRouteGateway(text: string): string | null {
  const match = text.match(/\bvia\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return match ? match[1]! : null;
}

function wslNetworkingMode(distro: string): string {
  const output = runWsl(['-d', distro, 'wslinfo', '--networking-mode']);
  // wslinfo only exists on recent WSL builds; older ones are NAT-only.
  return output ? output.toString('utf8').trim().toLowerCase() : 'nat';
}

function wslDefaultRouteGateway(distro: string): string | null {
  const output = runWsl(['-d', distro, '--', 'sh', '-c', 'ip route show default']);
  return output ? parseDefaultRouteGateway(output.toString('utf8')) : null;
}

function wslHomeDir(distro: string): string | null {
  const output = runWsl(['-d', distro, '--', 'sh', '-c', 'echo "$HOME"']);
  const home = output?.toString('utf8').trim() ?? '';
  return home.startsWith('/') ? home : null;
}

/** Pure UNC construction for a POSIX path inside a distro. */
export function wslUncPath(distro: string, posixPath: string, root = '\\\\wsl.localhost'): string {
  return `${root}\\${distro}${posixPath.replace(/\//g, '\\')}`;
}

function accessibleDistroRoot(distro: string): string | null {
  for (const root of ['\\\\wsl.localhost', '\\\\wsl$']) {
    if (existsSync(`${root}\\${distro}\\`)) return root;
  }
  return null;
}

/** Shell probe evaluating to exit 0 when the tool exists in the distro. */
export function wslToolProbeCommand(tool: WslTool): string {
  const probe = WSL_TOOL_PROBES[tool];
  return [
    `command -v ${probe.binary} >/dev/null 2>&1`,
    ...probe.signals.map((signal) => `test -e "$HOME/${signal}"`),
  ].join(' || ');
}

function wslHasTool(distro: string, tool: WslTool): boolean {
  return runWsl(['-d', distro, '--', 'sh', '-c', wslToolProbeCommand(tool)]) !== null;
}

/**
 * Find every WSL distro with an install of `tool` and resolve where its
 * config lives (as Windows UNC paths) and which host it can reach the buyer
 * proxy on. `posix` paths are the profile's `~/`-rooted config locations —
 * for tools whose native `configPath` was resolved to a Windows known folder
 * (crush, goose), the caller passes the POSIX variant kept on the profile.
 */
/** True for paths that can be mapped into a distro: `~/`-rooted or absolute
    POSIX. A Windows known-folder path here means the profile set installProbe
    without a wslConfigPath — nothing sane can be written inside a distro. */
export function isMappablePosixPath(value: string): boolean {
  return value.startsWith('~/') || value.startsWith('/');
}

export function discoverWslToolTargets(
  tool: WslTool,
  posix: { configPath: string; settingsPath?: string },
): WslConfigTarget[] {
  if (!isMappablePosixPath(posix.configPath)) return [];
  if (posix.settingsPath !== undefined && !isMappablePosixPath(posix.settingsPath)) return [];
  if (process.platform !== 'win32') return [];
  const targets: WslConfigTarget[] = [];
  for (const distro of listWslDistros()) {
    if (!wslHasTool(distro, tool)) continue;
    const home = wslHomeDir(distro);
    const root = accessibleDistroRoot(distro);
    if (!home || !root) continue;
    const expand = (posixPath: string): string =>
      wslUncPath(distro, posixPath.startsWith('~/') ? `${home}/${posixPath.slice(2)}` : posixPath, root);
    const mirrored = wslNetworkingMode(distro) === 'mirrored';
    const host = mirrored ? 'localhost' : wslDefaultRouteGateway(distro);
    if (!host) continue;
    targets.push({
      tool,
      distro,
      configPath: expand(posix.configPath),
      ...(posix.settingsPath ? { settingsPath: expand(posix.settingsPath) } : {}),
      host,
      needsRelay: !mirrored,
    });
  }
  return targets;
}

/**
 * Applied-targets memory, so disconnect/quit can unpatch the same files (and
 * stop the relay) without re-running WSL discovery — which would cold-start
 * distros on the quit path. One shared file holds every tool's rows; writes
 * replace only the given tool's rows.
 */
export function saveWslTargetsForTool(filePath: string, tool: WslTool, targets: readonly WslConfigTarget[]): void {
  const merged = [
    ...readWslTargets(filePath).filter((target) => target.tool !== tool),
    ...targets,
  ];
  try {
    if (merged.length === 0) {
      unlinkSync(filePath);
    } else {
      writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    }
  } catch {
    // Best-effort memory; discovery at the next connect rebuilds it.
  }
}

export function readWslTargets(filePath: string): WslConfigTarget[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is WslConfigTarget => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const raw = entry as Record<string, unknown>;
      return isWslTool(raw['tool'])
        && typeof raw['distro'] === 'string'
        && typeof raw['configPath'] === 'string'
        && (raw['settingsPath'] === undefined || typeof raw['settingsPath'] === 'string')
        && typeof raw['host'] === 'string'
        && typeof raw['needsRelay'] === 'boolean';
    });
  } catch {
    return [];
  }
}

export function readWslTargetsForTool(filePath: string, tool: WslTool): WslConfigTarget[] {
  return readWslTargets(filePath).filter((target) => target.tool === tool);
}

export function clearWslTargetsForTool(filePath: string, tool: WslTool): void {
  saveWslTargetsForTool(filePath, tool, []);
}
