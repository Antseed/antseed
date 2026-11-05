/**
 * Install attribution: carries the website visitor's GA4 identity into the
 * app so post-install milestones can be attributed to the campaign that
 * produced the download.
 *
 * How the identity travels (see apps/download-proxy/src/attribution.ts):
 * the download proxy stamps a signed token into the installer's filename;
 * the Windows installer writes its own filename next to the app, AppImage
 * exposes its path in $APPIMAGE, and this module reads the token from
 * either. macOS installs have no such channel (the .dmg name does not
 * survive the drag to /Applications) and report unattributed.
 *
 * What leaves the device: the token (which only the proxy can decode), a
 * random per-install id, and the same coarse buckets the PostHog telemetry
 * already sends. No wallet address, no raw model or peer identifiers. The
 * reporter follows the telemetry kill switches and the in-app opt-out.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { TelemetryContext } from './telemetry.js';

/** Runtime override for the proxy endpoint; release builds bake BAKED_ATTRIBUTION_ENDPOINT. */
export const ATTRIBUTION_ENDPOINT_ENV = 'ATTRIBUTION_ENDPOINT';
/** Written by the NSIS installer (build/installer.nsh) next to the executable. */
export const INSTALLER_NAME_FILE = 'installer-name.txt';
export const ATTRIBUTION_REPORT_TIMEOUT_MS = 4_000;

/** Mirrors the proxy's filename stamp: `<name>.a-<token>.<ext>`. */
const STAMP_RE = /\.a-(1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22})\.[A-Za-z0-9]+$/;

export type AttributionMilestone =
  | 'app_first_opened'
  | 'app_onboarded'
  | 'app_activated'
  | 'tool_connected'
  | 'first_chat_started'
  | 'deposit_completed';

/** Which action first made an install count as activated. */
export type ActivationKind = 'tool_connected' | 'first_chat' | 'deposit' | 'routing' | 'api_config' | 'plugin';

export function installTokenFromFilename(filename: string): string | null {
  const match = STAMP_RE.exec(filename.trim());
  return match ? match[1]! : null;
}

export type ReadInstallTokenOptions = {
  platform: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  readTextFile?: (file: string) => Promise<string>;
};

/** The install token for this installation, or null when no stamp reached it. */
export async function readInstallToken(options: ReadInstallTokenOptions): Promise<string | null> {
  const readTextFile = options.readTextFile ?? ((file: string) => readFile(file, 'utf8'));
  try {
    if (options.platform === 'win32') {
      const text = await readTextFile(path.join(path.dirname(options.execPath), INSTALLER_NAME_FILE));
      return installTokenFromFilename(path.basename(text.trim()));
    }
    if (options.platform === 'linux') {
      const appImage = options.env['APPIMAGE'];
      return appImage ? installTokenFromFilename(path.basename(appImage)) : null;
    }
  } catch {
    // Missing or unreadable stamp: the install is simply unattributed.
  }
  return null;
}

export type AttributionReporter = {
  /**
   * Report a milestone. `once` milestones are sent a single time per
   * installation: the mark is recorded synchronously (the caller persists
   * state), the network delivery is detached. Returns the delivery promise
   * for tests; callers do not await it.
   */
  report: (
    name: AttributionMilestone,
    params?: Record<string, string | number | boolean>,
    options?: { once?: boolean },
  ) => Promise<void>;
};

export type CreateAttributionReporterOptions = {
  endpoint: string;
  isEnabled: () => boolean;
  context: () => TelemetryContext;
  getToken: () => string | null;
  getInstallId: () => string;
  hasSent: (name: AttributionMilestone) => boolean;
  /** Synchronous: must only mutate in-memory state. */
  markSent: (name: AttributionMilestone) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createAttributionReporter(options: CreateAttributionReporterOptions): AttributionReporter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.endpoint.replace(/\/+$/, '')}/app-events`;
  const timeoutMs = options.timeoutMs ?? ATTRIBUTION_REPORT_TIMEOUT_MS;

  return {
    report(name, params = {}, reportOptions = {}) {
      if (!options.isEnabled()) return Promise.resolve();
      if (reportOptions.once) {
        if (options.hasSent(name)) return Promise.resolve();
        options.markSent(name);
      }
      const context = options.context();
      const body = {
        token: options.getToken(),
        install_id: options.getInstallId(),
        events: [{
          name,
          params: {
            platform: context.platform,
            arch: context.arch,
            app_version: context.appVersion,
            install_source: context.installSource,
            ...params,
          },
        }],
      };
      return deliver(fetchImpl, url, body, timeoutMs);
    },
  };
}

async function deliver(fetchImpl: typeof fetch, url: string, body: unknown, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Offline, blocked, or slow: attribution must never affect the app.
  } finally {
    clearTimeout(timer);
  }
}
