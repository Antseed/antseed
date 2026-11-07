/**
 * The desktop's gateway: starts the local one (`antseed gateway start`, which
 * supervises the buyer), hands out the base URL + API key the chat and the
 * connected apps use, and builds links into the gateway console where usage,
 * keys, limits and funding are managed.
 */
import { parseGatewayKeyInfo } from './key-info.js';
import type { GatewayKeyInfo, GatewayPrivacy, GatewayStatus } from '../../shared/gateway-types.js';
import { publishKeyWithPolicy } from './key-with-policy.js';
import { resolveConnectDataDir, DEFAULT_LOCAL_GATEWAY_PORT, type ProcessManager, type RuntimeMode } from '../runtime/process-manager.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { encryptedIdentityPath, ensureSecureIdentity, isStoredIdentityUnreadable, secureIdentityEnv } from '../identity.js';
import { isDesktopDebugEnabled } from '../app-context.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DESKTOP_KEY_SCOPE,
  deleteLocalKey,
  getGatewaySettings,
  getLocalKey,
  getRemoteKey,
  listLocalKeys,
  setLocalKey,
  updateGatewaySettings,
  type GatewayPrivacyMode,
  type GatewayMode,
  type StoredGatewayKey,
} from './settings.js';

export type { GatewayPrivacy, GatewayStatus };

export type GatewayEndpoint = {
  mode: GatewayMode;
  /** Origin without `/v1`. */
  origin: string;
  apiKey: string;
};

type Deps = {
  processManager: ProcessManager;
  appendLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void;
};

let injected: Deps | null = null;
let lastError: string | null = null;
let lastReachable = false;
let startPromise: Promise<void> | null = null;
const keyPromises = new Map<string, Promise<StoredGatewayKey>>();

export function initGatewayService(deps: Deps): void {
  injected = deps;
}

function deps(): Deps {
  if (!injected) throw new Error('gateway service used before initGatewayService()');
  return injected;
}

export function localGatewayOrigin(): string {
  return `http://127.0.0.1:${DEFAULT_LOCAL_GATEWAY_PORT}`;
}

function currentOrigin(): string | null {
  const settings = getGatewaySettings();
  return settings.mode === 'remote' ? settings.remoteUrl : localGatewayOrigin();
}

function isLocalRunning(): boolean {
  return deps().processManager.getState().some((state) => state.mode === 'gateway' && state.running);
}

/** Any HTTP answer counts: a remote gateway from before `/healthz` answers 404. */
async function probe(origin: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Throws unless this URL and key work together. Redirects are refused, so the key only goes to `origin`. */
export async function checkRemoteGateway({ origin, apiKey }: { origin: string; apiKey: string }): Promise<void> {
  const response = await fetch(`${origin}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch((err: unknown) => {
    throw new Error(`Could not reach ${origin}: ${err instanceof Error ? err.message : String(err)}`);
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) throw new Error('The gateway rejected this API key');
  if (!response.ok) throw new Error(`${origin} doesn't look like a working gateway (HTTP ${response.status})`);
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
  const settings = getGatewaySettings();
  const origin = currentOrigin();
  const running = settings.mode === 'remote' ? true : isLocalRunning();
  lastReachable = origin ? await probe(origin) : false;
  const hasKey = settings.mode === 'remote' ? getRemoteKey() !== null : getLocalKey(DESKTOP_KEY_SCOPE) !== null;
  return { mode: settings.mode, origin, keyMode: settings.keyMode, running, reachable: lastReachable, hasKey, lastError };
}

/** Starts the local gateway (and through it the buyer) and waits until it answers. No-op in remote mode. */
/** Settles once the router plugin install is done. */
let startGate: Promise<void> = Promise.resolve();

/**
 * Holds every start of the local gateway until `gate` settles. Its buyer loads
 * the router plugin and installs it if missing, so starting during the desktop's
 * own install runs two npm installs in one folder, which can leave it corrupted.
 * The renderer's first reads start the gateway too, so this can't be left to the launch order.
 */
export function holdLocalGatewayUntil(gate: Promise<void>): void {
  startGate = gate;
}

export async function ensureLocalGateway(): Promise<void> {
  await startGate;
  if (getGatewaySettings().mode !== 'local') return;
  if (isLocalRunning() && await probe(localGatewayOrigin())) return;
  startPromise ??= (async () => {
    try {
      if (!isLocalRunning()) {
        await ensureSecureIdentity();
        // Never start on another wallet: without the signer key the CLI
        // would use or create a different identity.
        if (isStoredIdentityUnreadable()) {
          throw new Error(`Your signer key (${encryptedIdentityPath()}) can't be read by this version of the app, so the gateway won't start with a different wallet. A backup was saved next to it. Reopen the app, or reinstall the previous version to read it.`);
        }
        await deps().processManager.start({
          mode: 'gateway',
          configPath: ACTIVE_CONFIG_PATH,
          ...(isDesktopDebugEnabled() ? { verbose: true } : {}),
          env: {
            ...(isDesktopDebugEnabled() ? { ANTSEED_DEBUG: '1' } : {}),
            ...secureIdentityEnv(),
          },
        }).catch((err: unknown) => {
          if (!(err instanceof Error && err.message.includes('already running'))) throw err;
        });
      }
      // The gateway waits for its buyer (up to a minute) before it serves.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await probe(localGatewayOrigin(), 1_500)) {
          lastError = null;
          return;
        }
        if (!isLocalRunning()) throw new Error('The local gateway exited while starting; see the runtime log');
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      throw new Error('The local gateway did not start in time');
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      startPromise = null;
    }
  })();
  await startPromise;
}

export async function stopLocalGateway(): Promise<void> {
  await deps().processManager.stop('gateway');
}

async function runGatewayCli(args: string[]): Promise<string> {
  const result = await deps().processManager.runCliCommand(
    ['--config', ACTIVE_CONFIG_PATH, '--data-dir', resolveConnectDataDir(), 'gateway', ...args],
    'gateway',
    { logStdout: false },
  );
  return result.stdout;
}

async function createLocalKey(label: string): Promise<StoredGatewayKey> {
  const stdout = await runGatewayCli(['key', 'create', '--label', label, '--json']);
  const parsed = JSON.parse(stdout) as { id?: unknown; apiKey?: unknown };
  if (typeof parsed.apiKey !== 'string' || !parsed.apiKey) throw new Error('The gateway did not return an API key');
  return { id: typeof parsed.id === 'string' ? parsed.id : null, label, secret: parsed.apiKey };
}

async function revokeLocalKey(id: string): Promise<void> {
  await runGatewayCli(['key', 'revoke', id]).catch((err: unknown) => {
    deps().appendLog('gateway', 'system', `Could not revoke key ${id}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** True when the gateway rejects this key (revoked, or the gateway's database was reset). */
async function keyRejected(origin: string, secret: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/v1/key`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 401;
  } catch {
    return false;
  }
}

function scopeLabel(scope: string, appLabel?: string): string {
  return scope === DESKTOP_KEY_SCOPE ? 'Desktop' : `Desktop · ${appLabel ?? scope}`;
}

/** The local key for `scope`, created on first use and re-created when the gateway no longer accepts it. */
async function ensureLocalKey(scope: string, appLabel?: string): Promise<StoredGatewayKey> {
  const pending = keyPromises.get(scope);
  if (pending) return pending;
  const promise = (async () => {
    const existing = getLocalKey(scope);
    if (existing && !(await keyRejected(localGatewayOrigin(), existing.secret))) return existing;
    if (existing) deps().appendLog('gateway', 'system', `The gateway no longer accepts the "${existing.label}" key; creating a new one`);
    // A new desktop key (first run, replaced, or the gateway forgot the old
    // one) starts with no policy. In Private it can't be used until it has one,
    // or requests could reach any seller while the app says Private.
    const carryPrivate = scope === DESKTOP_KEY_SCOPE && getGatewaySettings().privacy === 'private';
    return publishKeyWithPolicy({
      create: () => createLocalKey(scopeLabel(scope, appLabel)),
      applyPolicy: carryPrivate
        ? async (key) => {
          if (!key.id) throw new Error('The new key has no id on the gateway');
          await applyPrivacyToKey(key.id, 'private');
        }
        : null,
      revoke: async (key) => { if (key.id) await revokeLocalKey(key.id); },
      save: (key) => setLocalKey(scope, key),
    });
  })().finally(() => keyPromises.delete(scope));
  keyPromises.set(scope, promise);
  return promise;
}

/**
 * Base URL + key for a consumer. `appName` is a connected app's profile name;
 * in per-app key mode it gets its own key, otherwise everything shares the
 * desktop key. The chat passes no app.
 */
export async function getGatewayEndpoint(app?: { name: string; label?: string }): Promise<GatewayEndpoint> {
  const settings = getGatewaySettings();
  if (settings.mode === 'remote') {
    const apiKey = getRemoteKey();
    if (!settings.remoteUrl) throw new Error('Set the gateway URL in Settings');
    if (!apiKey) throw new Error('Add the gateway API key in Settings');
    return { mode: 'remote', origin: settings.remoteUrl, apiKey };
  }
  await ensureLocalGateway();
  const scope = app && settings.keyMode === 'per-app' ? app.name : DESKTOP_KEY_SCOPE;
  const key = await ensureLocalKey(scope, app?.label);
  return { mode: 'local', origin: localGatewayOrigin(), apiKey: key.secret };
}

/** Revokes and replaces local keys: one scope, or all of them. Callers re-patch apps afterwards. */
export async function rotateLocalKeys(scope?: string): Promise<void> {
  if (getGatewaySettings().mode !== 'local') throw new Error('Keys of a remote gateway are managed in its console');
  await ensureLocalGateway();
  const scopes = scope ? [scope] : listLocalKeys().map((entry) => entry.scope);
  for (const target of scopes) {
    const existing = getLocalKey(target);
    deleteLocalKey(target);
    if (existing?.id) await revokeLocalKey(existing.id);
  }
}

/** Revokes per-app keys that are no longer used (after switching back to one shared key). */
export async function revokeUnusedAppKeys(): Promise<void> {
  if (getGatewaySettings().keyMode === 'per-app') return;
  for (const entry of listLocalKeys()) {
    if (entry.scope === DESKTOP_KEY_SCOPE) continue;
    deleteLocalKey(entry.scope);
    if (entry.id) await revokeLocalKey(entry.id);
  }
}

/**
 * A console URL for `path` (e.g. `/keys`, `/wallet?fund=1`). A local gateway
 * that has no owner yet gets its one-time setup link instead: the user adds a
 * passkey or wallet once, and signs in with it from then on.
 */
export async function gatewayConsoleUrl(pathname = ''): Promise<string> {
  const settings = getGatewaySettings();
  const suffix = pathname && !pathname.startsWith('/') ? `/${pathname}` : pathname;
  if (settings.mode === 'remote') {
    if (!settings.remoteUrl) throw new Error('Set the gateway URL in Settings');
    return `${settings.remoteUrl}/console${suffix}`;
  }
  await ensureLocalGateway();
  const stdout = await runGatewayCli(['console-link', '--json', '--port', String(DEFAULT_LOCAL_GATEWAY_PORT)]);
  const parsed = JSON.parse(stdout) as { url?: unknown; setupRequired?: unknown; setupLink?: unknown };
  if (parsed.setupRequired === true && typeof parsed.setupLink === 'string') return parsed.setupLink;
  const base = typeof parsed.url === 'string' ? parsed.url.replace(/\/$/, '') : `${localGatewayOrigin()}/console`;
  return `${base}${suffix}`;
}

/** What the gateway reports for the desktop key (`GET /v1/key`): spend, caps, paying wallet. */
export async function getGatewayKeyInfo(): Promise<GatewayKeyInfo | null> {
  try {
    const { origin, apiKey } = await getGatewayEndpoint();
    const response = await fetch(`${origin}/v1/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return parseGatewayKeyInfo(await response.json());
  } catch {
    return null;
  }
}

type KeyPolicyView = { ownerRoutingPolicy: Record<string, unknown> | null; effective: Record<string, unknown> };

async function readKeyPolicy(id: string): Promise<KeyPolicyView> {
  const parsed = JSON.parse(await runGatewayCli(['key', 'policy', 'show', id, '--json'])) as Partial<KeyPolicyView>;
  const owner = parsed.ownerRoutingPolicy;
  return {
    ownerRoutingPolicy: owner && typeof owner === 'object' ? owner : null,
    effective: parsed.effective && typeof parsed.effective === 'object' ? parsed.effective : {},
  };
}

/**
 * Sets or removes `requireTee` on the key's owner layer and keeps the rest of
 * that layer as the user left it in the console. The admin layer, where
 * admins set policy, is never touched.
 */
async function applyPrivacyToKey(id: string, mode: GatewayPrivacyMode): Promise<void> {
  const { ownerRoutingPolicy } = await readKeyPolicy(id);
  const next: Record<string, unknown> = { ...(ownerRoutingPolicy ?? {}) };
  if (mode === 'private') next['requireTee'] = true;
  else delete next['requireTee'];
  if ((ownerRoutingPolicy?.['requireTee'] === true) === (mode === 'private')) return;
  if (Object.keys(next).length === 0) {
    await runGatewayCli(['key', 'policy', 'clear', id, '--layer', 'owner']);
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-policy-'));
  try {
    const file = path.join(dir, 'policy.json');
    await writeFile(file, JSON.stringify(next), { mode: 0o600 });
    // --confirm-empty: Private stays on even when no TEE seller is online right now.
    await runGatewayCli(['key', 'policy', 'set', id, '--layer', 'owner', '--file', file, '--confirm-empty']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Anonymous or Private, as the desktop key's routing policy has it. */
export async function getGatewayPrivacy(): Promise<GatewayPrivacy> {
  const settings = getGatewaySettings();
  if (settings.mode === 'remote') return { mode: 'anonymous', editable: false, requiredAbove: false };
  await ensureLocalGateway();
  const key = await ensureLocalKey(DESKTOP_KEY_SCOPE);
  if (!key.id) return { mode: settings.privacy, editable: false, requiredAbove: false };
  const { ownerRoutingPolicy, effective } = await readKeyPolicy(key.id);
  const effectiveTee = effective['requireTee'] === true;
  const requiredAbove = effectiveTee && ownerRoutingPolicy?.['requireTee'] !== true;
  const mode: GatewayPrivacyMode = effectiveTee ? 'private' : 'anonymous';
  // The console may have changed it; the key's policy is what routing follows.
  if (!requiredAbove && mode !== settings.privacy) updateGatewaySettings({ privacy: mode });
  return { mode, editable: true, requiredAbove };
}

/** Settles once no privacy switch is being applied. Sends that the renderer can't hold wait on it. */
let privacySwitch: Promise<unknown> = Promise.resolve();

export function whenPrivacySettled(): Promise<void> {
  return privacySwitch.then(() => undefined, () => undefined);
}

export function setGatewayPrivacy(mode: GatewayPrivacyMode): Promise<GatewayPrivacy> {
  const applying = applyGatewayPrivacy(mode);
  privacySwitch = applying;
  return applying;
}

async function applyGatewayPrivacy(mode: GatewayPrivacyMode): Promise<GatewayPrivacy> {
  if (getGatewaySettings().mode === 'remote') throw new Error('A remote gateway\'s routing policy is set in its console');
  await ensureLocalGateway();
  const key = await ensureLocalKey(DESKTOP_KEY_SCOPE);
  if (!key.id) throw new Error('The desktop key has no id on the gateway');
  await applyPrivacyToKey(key.id, mode);
  updateGatewaySettings({ privacy: mode });
  return getGatewayPrivacy();
}
