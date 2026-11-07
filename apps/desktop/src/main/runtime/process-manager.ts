import { askProcessToStop, forceProcessToStop } from './stop-process.js';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { WORKSPACE_APPS_DIR } from '../paths.js';
import { desktopTelemetryChildEnv } from '../telemetry/host-env.js';

const { join, resolve } = path;

export type RuntimeMode = 'gateway';

/** Where the local gateway serves its API and console (dev instances set their own). */
export const DEFAULT_LOCAL_GATEWAY_PORT = Number(process.env['ANTSEED_DESKTOP_GATEWAY_PORT']) || 8379;

export interface RuntimeProcessState {
  mode: RuntimeMode;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastError: string | null;
}

export interface StartOptions {
  mode: RuntimeMode;
  configPath?: string;
  verbose?: boolean;
  env?: Record<string, string>;
  gatewayPort?: number;
}

export interface DaemonStateSnapshot {
  exists: boolean;
  state: Record<string, unknown> | null;
}

export interface CliCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MIN_NODE_MAJOR_VERSION = 20;
const DEFAULT_CLI_COMMAND = 'antseed';
const CLI_COMMAND_ENV = 'ANTSEED_CLI_BIN';
const CLI_NODE_BIN_ENV = 'ANTSEED_NODE_BIN';
const LOCAL_CLI_BIN_RELATIVE = ['..', 'cli', 'dist', 'cli', 'index.js'] as const;
const RUNTIME_NATIVE_SCRIPT_RELATIVE = ['scripts', 'ensure-runtime-native-modules.mjs'] as const;
const RUNTIME_NATIVE_MARKER_FILE = '.runtime-native-meta.json';
const DEFAULT_CONFIG_PATH = join(homedir(), '.antseed', 'config.json');
const DEFAULT_CONNECT_DATA_DIR = join(homedir(), '.antseed');
const CONNECT_DATA_DIR_ENV = 'ANTSEED_DESKTOP_CONNECT_DATA_DIR';

function resolveAlignedNodeFromMarker(): string | null {
  const markerCandidates = [
    resolve(process.cwd(), RUNTIME_NATIVE_MARKER_FILE),
    resolve(process.cwd(), 'desktop', RUNTIME_NATIVE_MARKER_FILE),
  ];

  for (const markerPath of markerCandidates) {
    if (!existsSync(markerPath)) {
      continue;
    }
    try {
      const raw = readFileSync(markerPath, 'utf8');
      const parsed = JSON.parse(raw) as { nodeExec?: unknown };
      const nodeExec = typeof parsed.nodeExec === 'string' ? parsed.nodeExec.trim() : '';
      if (nodeExec.length > 0 && existsSync(nodeExec)) {
        return nodeExec;
      }
    } catch {
      // Ignore malformed marker files and continue with normal candidate resolution.
    }
  }

  return null;
}

function resolveCliCommand(): string {
  const envCommand = process.env[CLI_COMMAND_ENV]?.trim();
  if (envCommand && envCommand.length > 0) {
    return envCommand;
  }

  const localCli = resolveLocalCliPath();
  if (existsSync(localCli)) {
    return localCli;
  }

  // Packaged app: CLI dist copied into Resources/cli-dist/ via extraResources
  if (typeof process.resourcesPath === 'string') {
    const bundledCli = join(process.resourcesPath, 'cli-dist', 'cli', 'index.js');
    if (existsSync(bundledCli)) {
      return bundledCli;
    }
  }

  return DEFAULT_CLI_COMMAND;
}

function resolveLocalCliPath(): string {
  const candidates = [
    // Desktop package cwd (apps/desktop).
    resolve(process.cwd(), ...LOCAL_CLI_BIN_RELATIVE),
    // Monorepo root cwd.
    resolve(process.cwd(), 'apps', 'cli', 'dist', 'cli', 'index.js'),
    // Sibling workspace package, located from the app root rather than cwd.
    resolve(WORKSPACE_APPS_DIR, 'cli', 'dist', 'cli', 'index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

/**
 * Build NODE_PATH so that a child process spawned from the packaged app
 * can resolve modules from the unpacked node_modules directory.
 */
function resolveChildNodePath(): string {
  const paths: string[] = [];
  if (typeof process.resourcesPath === 'string') {
    // electron-builder unpacks node_modules here when asarUnpack includes them
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
    if (existsSync(unpacked)) {
      paths.push(unpacked);
    }
  }
  return paths.join(path.delimiter);
}

function detectNodeArch(nodeBinary: string): string | null {
  try {
    const output = execFileSync(nodeBinary, ['-p', 'process.arch'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function detectNodeMajorVersion(nodeBinary: string): number | null {
  try {
    const output = execFileSync(nodeBinary, ['-p', 'process.versions.node.split(".")[0]'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const major = Number(output);
    return Number.isFinite(major) && major > 0 ? major : null;
  } catch {
    return null;
  }
}

type SemverTuple = [major: number, minor: number, patch: number];

function parseSemverTag(raw: string): SemverTuple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a: SemverTuple, b: SemverTuple): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  return b[2] - a[2];
}

function resolveNodeBinary(targetArch: string): string {
  // When packaged, prefer Electron's own Node.js runtime — its version matches
  // the bundled native modules (better-sqlite3, node-datachannel).  A system
  // node with a different major version would fail to load those modules.
  const isPackaged = typeof process.resourcesPath === 'string'
    && existsSync(join(process.resourcesPath, 'app.asar'));
  if (isPackaged) {
    return process.execPath;
  }

  const alignedNode = resolveAlignedNodeFromMarker();
  if (alignedNode) {
    return alignedNode;
  }

  const envNode = process.env[CLI_NODE_BIN_ENV]?.trim();
  const candidates: string[] = [];
  if (envNode) {
    candidates.push(envNode);
  }

  const nvmBin = process.env['NVM_BIN']?.trim();
  if (nvmBin) {
    candidates.push(join(nvmBin, 'node'));
  }

  const nvmVersionsDir = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    try {
      const nvmVersions = readdirSync(nvmVersionsDir)
        .map((name) => ({ name, semver: parseSemverTag(name) }))
        .sort((left, right) => {
          if (left.semver && right.semver) {
            return compareSemverDesc(left.semver, right.semver);
          }
          if (left.semver) return -1;
          if (right.semver) return 1;
          return right.name.localeCompare(left.name);
        })
        .map((entry) => entry.name);
      for (const version of nvmVersions) {
        candidates.push(join(nvmVersionsDir, version, 'bin', 'node'));
      }
    } catch {
      // Ignore nvm lookup failures and continue with other candidates.
    }
  }

  candidates.push('/opt/homebrew/bin/node');
  candidates.push('/usr/local/bin/node');
  candidates.push('node');

  const tried = new Set<string>();
  let firstExisting: string | null = null;
  let firstCompatible: string | null = null;

  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) {
      continue;
    }
    tried.add(candidate);
    if (candidate !== 'node' && !existsSync(candidate)) {
      continue;
    }
    const majorVersion = detectNodeMajorVersion(candidate);
    if (majorVersion === null) {
      // Candidate doesn't exist or can't execute — skip it entirely.
      continue;
    }
    if (!firstExisting) {
      firstExisting = candidate;
    }
    const meetsMinVersion = majorVersion >= MIN_NODE_MAJOR_VERSION;
    if (meetsMinVersion) {
      if (!firstCompatible) {
        firstCompatible = candidate;
      }
      const arch = detectNodeArch(candidate);
      if (arch === targetArch) {
        return candidate;
      }
    }
  }

  return firstCompatible ?? firstExisting ?? process.execPath ?? 'node';
}

function resolveConfigPath(configPath?: string): string {
  if (!configPath || configPath.trim().length === 0) {
    return DEFAULT_CONFIG_PATH;
  }
  if (configPath.startsWith('~/')) {
    return join(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}

export function resolveConnectDataDir(): string {
  const envDir = process.env[CONNECT_DATA_DIR_ENV]?.trim();
  if (envDir && envDir.length > 0) {
    if (envDir.startsWith('~/')) {
      return join(homedir(), envDir.slice(2));
    }
    return resolve(envDir);
  }
  return DEFAULT_CONNECT_DATA_DIR;
}

type CliExecution = {
  executable: string;
  executableArgsPrefix: string[];
  // True only for the local monorepo dev script — native module alignment is
  // only needed there. The bundled production CLI already ships aligned natives.
  isLocalDevScript: boolean;
  cliCommand: string;
};

export function buildCliChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  isLocalDevScript: boolean,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...desktopTelemetryChildEnv() };
  if (isLocalDevScript) {
    delete childEnv['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'];
  } else {
    childEnv['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'] = '1';
  }
  return childEnv;
}

function resolveCliExecution(): CliExecution {
  const cliCommand = resolveCliCommand();
  const localCliPath = resolveLocalCliPath();
  const isLocalDevScript = existsSync(localCliPath) && resolve(cliCommand) === localCliPath;

  // The bundled CLI (from extraResources) is also a .js script that needs node.
  // Packaged macOS apps have a minimal PATH, so we must resolve node explicitly.
  const isBundledScript = !isLocalDevScript && cliCommand.endsWith('.js');
  const needsNode = isLocalDevScript || isBundledScript;

  const executable = needsNode ? resolveNodeBinary(process.arch) : cliCommand;
  const executableArgsPrefix = needsNode ? [cliCommand] : [];
  return {
    executable,
    executableArgsPrefix,
    isLocalDevScript,
    cliCommand,
  };
}

export function resolveCommandArgs(opts: StartOptions): string[] {
  const args: string[] = [];

  if (opts.verbose) {
    args.push('--verbose');
  }

  const configPath = resolveConfigPath(opts.configPath);
  args.push('--config', configPath);

  switch (opts.mode) {
    case 'gateway':
      args.push('--data-dir', resolveConnectDataDir());
      args.push('gateway', 'start', '--port', String(opts.gatewayPort ?? DEFAULT_LOCAL_GATEWAY_PORT));
      break;
    default:
      throw new Error(`Unsupported runtime mode: ${String(opts.mode)}`);
  }

  return args;
}

/**
 * The gateway drains requests in flight (60s), then stops its buyer (up to 90s).
 * Killed before that, it never signals the buyer, which runs on in its own
 * process group and would be attached by the next start, even after a signer
 * import. It exits at once when nothing is in flight.
 */
const GATEWAY_STOP_KILL_MS = 155_000;

export class ProcessManager {
  private readonly processes = new Map<RuntimeMode, ChildProcessWithoutNullStreams>();
  private runtimeNativeAligned = false;
  private runtimeNativeAlignmentPromise: Promise<void> | null = null;
  private readonly states = new Map<RuntimeMode, RuntimeProcessState>([
    ['gateway', { mode: 'gateway', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
  ]);

  constructor(
    private readonly onLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void,
  ) {}

  getState(): RuntimeProcessState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  getDaemonStateSnapshot(): DaemonStateSnapshot {
    const stateFile = join(homedir(), '.antseed', 'daemon.state.json');
    if (!existsSync(stateFile)) {
      return { exists: false, state: null };
    }
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
      return { exists: true, state: parsed };
    } catch {
      return { exists: true, state: null };
    }
  }

  async start(opts: StartOptions): Promise<RuntimeProcessState> {
    const mode = opts.mode;
    if (this.processes.has(mode)) {
      throw new Error(`${mode} is already running`);
    }

    const cliExecution = resolveCliExecution();
    const args = resolveCommandArgs(opts);
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];
    await this.ensureRuntimeNativeModules(mode, executable, cliExecution.isLocalDevScript);
    const childEnv = buildCliChildEnv(process.env, cliExecution.isLocalDevScript);
    // Packaged desktop repairs trusted plugins from its own app bundle. Local
    // development keeps plugin preparation enabled so newly added workspace
    // plugins can be installed and exercised without a production bundle.
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (typeof key === 'string' && key.trim().length > 0) {
        childEnv[key] = String(value);
      }
    }
    // When using Electron's own binary as node, set ELECTRON_RUN_AS_NODE so it
    // behaves like a regular Node.js process. Otherwise, remove it.
    if (executable === process.execPath) {
      childEnv['ELECTRON_RUN_AS_NODE'] = '1';
    } else {
      delete childEnv['ELECTRON_RUN_AS_NODE'];
    }
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `${path.delimiter}${childEnv['NODE_PATH']}` : '');
    }

    const child = spawn(executable, executableArgs, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'pipe',
    });

    this.processes.set(mode, child);

    const state = this.states.get(mode)!;
    state.running = true;
    state.pid = child.pid ?? null;
    state.startedAt = Date.now();
    state.lastError = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          this.onLog(mode, 'stdout', line);
        }
      }
    });

    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          this.onLog(mode, 'stderr', line);
        }
      }
    });

    child.on('error', (err) => {
      state.lastError = err.message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        state.running = false;
        state.pid = null;
        this.processes.delete(mode);
        this.onLog(
          mode,
          'system',
          `CLI command "${cliExecution.cliCommand}" was not found (executable: "${executable}"). Install Node.js ≥${MIN_NODE_MAJOR_VERSION} or set ${CLI_COMMAND_ENV} to a valid executable path.`,
        );
        return;
      }
      this.onLog(mode, 'system', `Process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      this.processes.delete(mode);
      state.running = false;
      state.pid = null;
      state.lastExitCode = code;
      const reason = signal ? `signal=${signal}` : `code=${String(code)}`;
      this.onLog(mode, 'system', `Process exited (${reason})`);
    });

    this.onLog(
      mode,
      'system',
      `Started ${mode} with "${executable}" (pid=${String(child.pid ?? 'unknown')})`,
    );
    if (mode === 'gateway') {
      const dataDir = resolveConnectDataDir();
      this.onLog(mode, 'system', `Connect data dir: ${dataDir}`);
    }
    return { ...state };
  }

  /** `logStdout: false` keeps stdout out of the runtime log (for output that carries secrets). */
  async runCliCommand(args: string[], mode: RuntimeMode = 'gateway', options: { logStdout?: boolean } = {}): Promise<CliCommandResult> {
    const logStdout = options.logStdout !== false;
    const cliExecution = resolveCliExecution();
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];

    const childEnv = buildCliChildEnv(process.env, cliExecution.isLocalDevScript);
    if (executable === process.execPath) {
      childEnv['ELECTRON_RUN_AS_NODE'] = '1';
    } else {
      delete childEnv['ELECTRON_RUN_AS_NODE'];
    }
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `${path.delimiter}${childEnv['NODE_PATH']}` : '');
    }

    this.onLog(mode, 'system', `Running command: ${executableArgs.join(' ')}`);

    return await new Promise<CliCommandResult>((resolveCommand, rejectCommand) => {
      const child = spawn(executable, executableArgs, {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutTail = '';
      let stderrTail = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (!logStdout) return;
        stdoutTail += chunk;
        const lines = stdoutTail.split(/\r?\n/);
        stdoutTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        stderrTail += chunk;
        const lines = stderrTail.split(/\r?\n/);
        stderrTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          rejectCommand(
            new Error(
              `CLI command "${cliExecution.cliCommand}" was not found. Install antseed on PATH or set ${CLI_COMMAND_ENV} to a valid executable path.`,
            ),
          );
          return;
        }
        rejectCommand(new Error(`CLI command failed to start: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        if (stdoutTail.trim().length > 0) {
          this.onLog(mode, 'system', stdoutTail.trim());
        }
        if (stderrTail.trim().length > 0) {
          this.onLog(mode, 'system', stderrTail.trim());
        }

        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          const reason = signal ? `signal=${signal}` : `code=${String(exitCode)}`;
          const detail = stderr.trim() || (logStdout ? stdout.trim() : '');
          rejectCommand(
            new Error(
              detail.length > 0
                ? `Command failed (${reason}): ${detail}`
                : `Command failed (${reason})`,
            ),
          );
          return;
        }

        resolveCommand({ code: exitCode, stdout, stderr });
      });
    });
  }

  private async ensureRuntimeNativeModules(mode: RuntimeMode, executable: string, isLocalDevScript: boolean): Promise<void> {
    if (!isLocalDevScript) {
      return;
    }
    if (this.runtimeNativeAligned) {
      return;
    }
    if (this.runtimeNativeAlignmentPromise) {
      await this.runtimeNativeAlignmentPromise;
      return;
    }

    const scriptPath = resolve(process.cwd(), ...RUNTIME_NATIVE_SCRIPT_RELATIVE);
    if (!existsSync(scriptPath)) {
      this.onLog(mode, 'system', 'Native module preflight script not found; skipping runtime alignment.');
      return;
    }

    this.runtimeNativeAlignmentPromise = this.runRuntimeNativeAlignment(mode, executable, scriptPath)
      .then(() => {
        this.runtimeNativeAligned = true;
      })
      .catch((err) => {
        this.runtimeNativeAlignmentPromise = null;
        throw err;
      });

    await this.runtimeNativeAlignmentPromise;
  }

  private async runRuntimeNativeAlignment(mode: RuntimeMode, executable: string, scriptPath: string): Promise<void> {
    const childEnv = { ...process.env };
    delete childEnv['ELECTRON_RUN_AS_NODE'];

    await new Promise<void>((resolveAlignment, rejectAlignment) => {
      const child = spawn(executable, [scriptPath], {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutTail = '';
      let stderrTail = '';
      let stderrCapture = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdoutTail += chunk;
        const lines = stdoutTail.split(/\r?\n/);
        stdoutTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderrTail += chunk;
        stderrCapture += chunk;
        const lines = stderrTail.split(/\r?\n/);
        stderrTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.on('error', (err) => {
        rejectAlignment(new Error(`Native module alignment failed: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        if (stdoutTail.trim().length > 0) {
          this.onLog(mode, 'system', stdoutTail.trim());
        }
        if (stderrTail.trim().length > 0) {
          this.onLog(mode, 'system', stderrTail.trim());
        }

        if (code === 0) {
          resolveAlignment();
          return;
        }

        const reason = signal ? `signal=${signal}` : `code=${String(code)}`;
        const detail = stderrCapture.trim();
        rejectAlignment(
          new Error(
            detail.length > 0
              ? `Native module alignment failed (${reason}): ${detail}`
              : `Native module alignment failed (${reason})`,
          ),
        );
      });
    });
  }

  async stop(mode: RuntimeMode): Promise<RuntimeProcessState> {
    const child = this.processes.get(mode);
    const state = this.states.get(mode)!;

    if (!child) {
      state.running = false;
      state.pid = null;
      return { ...state };
    }

    await new Promise<void>((resolveStop) => {
      let resolved = false;
      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(forceKillTimeout);
        clearTimeout(resolveTimeout);
        resolveStop();
      };

      const timeout = setTimeout(() => {
        forceProcessToStop(child);
      }, GATEWAY_STOP_KILL_MS);
      const forceKillTimeout = timeout;
      const resolveTimeout = setTimeout(finish, GATEWAY_STOP_KILL_MS + 2_500);

      child.once('exit', finish);

      askProcessToStop(child);
    });

    return { ...state };
  }

  async stopAll(): Promise<void> {
    await this.stop('gateway');
  }
}
