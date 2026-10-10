/**
 * Persistent telemetry state, stored as JSON in the Electron userData
 * directory. The on-chain identifier is read from the encrypted identity and
 * is not duplicated here.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TelemetryState = {
  schemaVersion: number;
  /** ISO date (YYYY-MM-DD) of the first launch; coarse on purpose. */
  firstOpenDate: string | null;
  firstOpenedAtMs: number | null;
  hasEmittedFirstOpen: boolean;
  hasEmittedFirstChat: boolean;
  hasCompletedSetup: boolean;
  hasCompletedDeposit: boolean;
  /** Timestamped when first-run setup begins; null once completed. */
  setupStartedAtMs: number | null;
  /** Set while the app runs; cleared on clean shutdown (crash detection). */
  sessionActive: boolean;
  lastSessionId: string | null;
  lastSessionStartedAtMs: number | null;
  lastSessionHeartbeatAtMs: number | null;
  /** In-app opt-out. Defaults to false (telemetry on, opt-out model). */
  telemetryDisabled: boolean;
  /** Random per-install id used for unattributed milestone reports (see attribution.ts). */
  attributionInstallId: string | null;
  /** Signed token read from the installer filename; null when no stamp reached this install. */
  attributionToken: string | null;
  /** Once-per-install milestones already reported. */
  attributionSent: string[];
};

export type TelemetryStateLoadResult = {
  state: TelemetryState;
  source: 'stored' | 'missing' | 'invalid';
};

export function defaultTelemetryState(): TelemetryState {
  return {
    schemaVersion: 1,
    firstOpenDate: null,
    firstOpenedAtMs: null,
    hasEmittedFirstOpen: false,
    hasEmittedFirstChat: false,
    hasCompletedSetup: false,
    hasCompletedDeposit: false,
    setupStartedAtMs: null,
    sessionActive: false,
    lastSessionId: null,
    lastSessionStartedAtMs: null,
    lastSessionHeartbeatAtMs: null,
    telemetryDisabled: false,
    attributionInstallId: null,
    attributionToken: null,
    attributionSent: [],
  };
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalize(raw: unknown): TelemetryState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) return null;
  return {
    schemaVersion: 1,
    firstOpenDate: asStringOrNull(record['firstOpenDate']),
    firstOpenedAtMs: asNumberOrNull(record['firstOpenedAtMs']),
    hasEmittedFirstOpen: asBoolean(record['hasEmittedFirstOpen'], false),
    hasEmittedFirstChat: asBoolean(record['hasEmittedFirstChat'], false),
    hasCompletedSetup: asBoolean(record['hasCompletedSetup'], false),
    hasCompletedDeposit: asBoolean(record['hasCompletedDeposit'], false),
    setupStartedAtMs: asNumberOrNull(record['setupStartedAtMs']),
    sessionActive: asBoolean(record['sessionActive'], false),
    lastSessionId: (() => {
      const value = asStringOrNull(record['lastSessionId']);
      return value && isUuid(value) ? value : null;
    })(),
    lastSessionStartedAtMs: asNumberOrNull(record['lastSessionStartedAtMs']),
    lastSessionHeartbeatAtMs: asNumberOrNull(record['lastSessionHeartbeatAtMs']),
    telemetryDisabled: asBoolean(record['telemetryDisabled'], false),
    attributionInstallId: (() => {
      const value = asStringOrNull(record['attributionInstallId']);
      return value && isUuid(value) ? value : null;
    })(),
    attributionToken: asStringOrNull(record['attributionToken']),
    attributionSent: asStringArray(record['attributionSent']),
  };
}

export function telemetryStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'telemetry-state.json');
}

/** Loads and normalizes state; corrupt or missing files fall back to defaults. */
export async function loadTelemetryState(userDataDir: string): Promise<TelemetryState> {
  return (await loadTelemetryStateResult(userDataDir)).state;
}

export async function loadTelemetryStateResult(userDataDir: string): Promise<TelemetryStateLoadResult> {
  try {
    const text = await readFile(telemetryStatePath(userDataDir), 'utf8');
    try {
      const state = normalize(JSON.parse(text));
      return state
        ? { state, source: 'stored' }
        : { state: defaultTelemetryState(), source: 'invalid' };
    } catch {
      return { state: defaultTelemetryState(), source: 'invalid' };
    }
  } catch (error) {
    const source = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
    return { state: defaultTelemetryState(), source };
  }
}

/** Atomic write (tmp + rename) so a crash mid-save can't corrupt the file. */
export async function saveTelemetryState(userDataDir: string, state: TelemetryState): Promise<void> {
  try {
    const file = telemetryStatePath(userDataDir);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch {
    // Telemetry persistence failures must never affect app behavior.
  }
}
