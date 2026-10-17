/**
 * Updates from the gateway console a running tunnel publishes.
 *
 * The console's Update button cannot install anything itself: the gateway
 * runs inside the CLI the app bundles. Like the gateway installer's root
 * update service, the app is told about the update through two files the
 * tunnel's CLI is given in its environment:
 *
 * - `request`: the console creates it to ask for the update. Its `action`
 *   is the step, as on the app's own banner: `download` fetches the newest
 *   release the app's updater found, and `install` (the default) restarts
 *   into it, downloading it first when needed. Nothing else is read, and a
 *   file that is not a JSON object with one of those (or no action) is
 *   dropped.
 * - `status`: JSON the app writes. `app` carries the app's own versions,
 *   which are what the console shows (the CLI's npm version is not what the
 *   app ships), and the rest is the last update run, which the console polls.
 *
 * A download from the app's banner shows up as `ready` in the console too.
 * Installing restarts the app, so an install run is finished on the next
 * launch.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ConsoleUpdatePaths = { request: string; status: string };

type RunState = 'running' | 'ready' | 'succeeded' | 'failed';
type RunAction = 'download' | 'install';

type UpdateRun = {
  state: RunState;
  action: RunAction;
  from: string | null;
  to: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
};

type AppVersions = {
  current: string;
  latest: string | null;
  checkedAt: number | null;
  error: string | null;
};

export type ConsoleUpdatesDependencies = {
  paths: ConsoleUpdatePaths;
  appVersion: string;
  /** Starts downloading the release the updater found; the app reports it with `downloaded`. */
  download: () => void;
  /** Downloads the release the updater found, if needed, then quits and installs it. Throws when it cannot start. */
  install: () => Promise<void>;
  log: (message: string) => void;
  now?: () => number;
  pollMs?: number;
};

const POLL_MS = 2_000;

export function consoleUpdatePaths(dataDir: string): ConsoleUpdatePaths {
  const dir = path.join(dataDir, 'tunnel');
  return { request: path.join(dir, 'update-request'), status: path.join(dir, 'update-status.json') };
}

/** What the tunnel's CLI needs to hand the console's updates to the app. */
export function consoleUpdaterEnv(paths: ConsoleUpdatePaths): Record<string, string> {
  return {
    ANTSEED_UPDATER_REQUEST: paths.request,
    ANTSEED_UPDATER_STATUS: paths.status,
    ANTSEED_UPDATER_KIND: 'desktop',
  };
}

function parseVersion(version: string): { core: number[]; pre: string | null } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

/** Whether `candidate` is a newer version than `current`; a pre-release sorts before its release. */
export function isNewerVersion(candidate: string | null, current: string): boolean {
  const a = candidate ? parseVersion(candidate) : null;
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]!;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

function readRun(statusPath: string): UpdateRun | null {
  try {
    const raw = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    if (raw.state !== 'running' && raw.state !== 'ready' && raw.state !== 'succeeded' && raw.state !== 'failed') return null;
    if (typeof raw.startedAt !== 'number') return null;
    return {
      state: raw.state,
      action: raw.action === 'download' ? 'download' : 'install',
      from: typeof raw.from === 'string' ? raw.from : null,
      to: typeof raw.to === 'string' ? raw.to : null,
      startedAt: raw.startedAt,
      finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
      error: typeof raw.error === 'string' ? raw.error : null,
    };
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createConsoleUpdates(deps: ConsoleUpdatesDependencies) {
  const now = deps.now ?? Date.now;
  let app: AppVersions = { current: deps.appVersion, latest: null, checkedAt: null, error: null };
  let run = readRun(deps.paths.status);
  let timer: ReturnType<typeof setInterval> | null = null;

  const write = (): void => {
    try {
      mkdirSync(path.dirname(deps.paths.status), { recursive: true });
      const temp = `${deps.paths.status}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ ...(run ?? {}), app })}\n`);
      renameSync(temp, deps.paths.status);
    } catch (error) {
      deps.log(`Console update status could not be written: ${errorText(error)}`);
    }
  };

  const finish = (state: 'ready' | 'succeeded' | 'failed', error: string | null = null): void => {
    if (run?.state !== 'running') return;
    run = { ...run, state, finishedAt: now(), error };
    if (error) deps.log(`Update from the gateway console failed: ${error}`);
    write();
  };

  // A run that was going when the app quit ends here: installing restarts the app.
  if (run?.state === 'running' && run.action === 'install') {
    if (run.to === deps.appVersion) finish('succeeded');
    else finish('failed', `Antseed Desktop restarted without installing ${run.to ?? 'the update'}`);
  } else if (run?.state === 'running') {
    // A download ends with the app.
    run = null;
  } else if (run?.state === 'ready' && !isNewerVersion(run.to, deps.appVersion)) {
    // The updater installs a finished download when the app quits.
    run = run.to === deps.appVersion ? { ...run, action: 'install', state: 'succeeded', finishedAt: now() } : null;
  }
  write();

  // The CLI renames a whole request into place; anything else restarts nothing.
  const readAction = (): RunAction | null => {
    try {
      const request = JSON.parse(readFileSync(deps.paths.request, 'utf8')) as unknown;
      if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
      const action = (request as Record<string, unknown>).action ?? 'install';
      return action === 'download' || action === 'install' ? action : null;
    } catch {
      return null;
    }
  };

  const startRun = (action: RunAction): void => {
    if (run?.state === 'running') return;
    if (action === 'download' && run?.state === 'ready' && run.to === app.latest) return;
    const to = app.latest;
    run = { state: 'running', action, from: app.current, to, startedAt: now(), finishedAt: null, error: null };
    if (!isNewerVersion(to, app.current)) {
      finish('failed', `Antseed Desktop ${app.current} is already the latest version`);
      return;
    }
    write();
    if (action === 'download') {
      deps.log(`Downloading ${to} for the gateway console`);
      deps.download();
      return;
    }
    deps.log(`Updating to ${to} from the gateway console`);
    deps.install().catch((error: unknown) => finish('failed', errorText(error)));
  };

  const poll = (): void => {
    if (!existsSync(deps.paths.request)) return;
    const action = readAction();
    try {
      rmSync(deps.paths.request, { force: true });
    } catch {
      // Gone already; the request still counts once.
    }
    if (action) startRun(action);
    else deps.log('Ignored an incomplete update request from the gateway console');
  };

  return {
    /** The app's updater checked: `latest` is the newest release (the running version when there is none), or the check failed. */
    checked(latest: string | null, error: string | null = null): void {
      app = { ...app, latest: latest ?? app.latest, checkedAt: now(), error };
      write();
    },
    /** The app's updater finished downloading `version`, whoever asked for it. */
    downloaded(version: string): void {
      if (run?.state === 'running' && run.action === 'install') return;
      if (run?.state === 'running') {
        run = { ...run, to: version };
        finish('ready');
        return;
      }
      run = { state: 'ready', action: 'download', from: app.current, to: version, startedAt: now(), finishedAt: now(), error: null };
      write();
    },
    /** The download or install a console request started failed. */
    failed(error: string): void {
      finish('failed', error);
    },
    /** Whether a console request is downloading or installing an update. */
    running(): boolean {
      return run?.state === 'running';
    },
    start(): void {
      if (timer) return;
      poll();
      timer = setInterval(poll, deps.pollMs ?? POLL_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    poll,
  };
}
