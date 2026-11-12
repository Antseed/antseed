/**
 * The desktop's gateway: starts the local one (`antseed gateway start`, which
 * supervises the buyer), hands out the base URL + API key the chat and the
 * connected apps use, and builds links into the gateway console where usage,
 * keys, limits and funding are managed.
 */
import { PARENT_PID_ENV, STOP_ON_STDIN_CLOSE_ENV } from '@antseed/node/gateway-process';
import { parseGatewayKeyInfo, parseKeyRewards, parseKeySavings, parseRetiredUsage, sumSavings, withUsageOf, type KeyUsage } from './key-info.js';
import { readConfig } from '../runtime/config-io.js';
import type { GatewayKeyInfo, GatewayPrivacy, GatewayRewardsSummary, GatewaySavings, GatewayStatus } from '../../shared/gateway-types.js';
import { applyPrivacyToKeys, publishUnderCurrentPrivacy } from './privacy-keys.js';
import { publishKeyWithPolicy } from './key-with-policy.js';
import { assertKeyMayBeRecreated, keyIsUsable, rotateKeys, unusedAppKeyScopes, type KeyRecord } from './rotate-keys.js';
import { createForeignBuyerGuard, foreignBuyerMessage, portInUse, restartForNewIdentity } from './restart-for-identity.js';
import { createSerialQueue } from '../serial-queue.js';
import { privacyInTurn, type PrivacyRead } from './privacy-switch.js';
import { CLOSING_ERROR, START_CANCELLED_ERROR, StartGenerations, startUnlessCancelled } from './start-guard.js';
import { resolveConnectDataDir, DEFAULT_LOCAL_GATEWAY_PORT, type ProcessManager, type RuntimeMode } from '../runtime/process-manager.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { encryptedIdentityPath, ensureSecureIdentity, getSecureIdentity, isStoredIdentityUnreadable, secureIdentityEnv } from '../identity.js';
import { attachedGateway } from '../runtime/attach-only.js';
import { gatewayKeyScope } from './key-scope.js';
import { buyerSignerMismatchMessage, compareBuyerSigner, liveBuyerAddress } from './buyer-signer.js';
import { isDesktopDebugEnabled } from '../app-context.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DESKTOP_KEY_SCOPE,
  deleteLocalKey,
  listRetiredKeyIds,
  retireLocalKey,
  getGatewaySettings,
  getLocalKey,
  getLocalKeyEntry,
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
  /** Every request made with this endpoint asks for TEE sellers only (a Private run). */
  requireTee?: boolean;
};

type Deps = {
  processManager: ProcessManager;
  appendLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void;
};

let injected: Deps | null = null;
let lastError: string | null = null;
let startPromise: Promise<void> | null = null;
const localStarts = new StartGenerations();
/** Starts in flight (ensureLocalGateway calls, including their wait for the plugin install). */
let startsInFlight = 0;
/** Whether any start has finished, either way, since launch. */
let startSettled = false;
let closing = false;
/** Whether the running local buyer was confirmed to pay from the desktop's signer since the gateway last started. */
let signerVerified = false;
/** A buyer the app doesn't run, found on the port after a new signer was imported. */
const foreignBuyerGuard = () => createForeignBuyerGuard(path.join(resolveConnectDataDir(), 'signer-change-pending.json'));
const DEFAULT_BUYER_PORT = 8377;
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
  const reachable = origin ? await probe(origin) : false;
  const hasKey = settings.mode === 'remote' ? getRemoteKey() !== null : getLocalKeyEntry(DESKTOP_KEY_SCOPE) !== null;
  // Before the first start of this launch has settled, a silent gateway is one
  // that hasn't come up yet, not one that is down.
  const starting = settings.mode === 'local' && !reachable && (startsInFlight > 0 || !startSettled);
  return { mode: settings.mode, origin, keyMode: settings.keyMode, running, reachable, starting, hasKey, lastError };
}

/** Starts the local gateway (and through it the buyer) and waits until it answers. No-op in remote mode. */
/** Settles once the router plugin install is done. */
let startGate: Promise<void> = Promise.resolve();

/**
 * Holds every start of the local gateway until `gate` settles. Its buyer loads
 * the router plugin and installs it if missing, so starting during the desktop's
 * own install runs two npm installs in one folder, which can leave it corrupted.
 * The renderer's first reads start the gateway too, so this can't be left to the launch order.
 * A gate that fails (the install did) fails every start with its reason.
 */
export function holdLocalGatewayUntil(gate: Promise<void>): void {
  startGate = gate;
  // A failed gate is reported by each start that awaits it, not as an unhandled rejection.
  gate.catch(() => undefined);
}

export async function ensureLocalGateway(): Promise<void> {
  // A remote gateway needs neither the local start nor the plugin it waits for.
  if (getGatewaySettings().mode !== 'local') return;
  startsInFlight += 1;
  try {
    await startLocalGateway();
  } finally {
    startsInFlight -= 1;
    startSettled = true;
  }
}

async function startLocalGateway(): Promise<void> {
  await startGate;
  if (closing) throw new Error(CLOSING_ERROR);
  if (getGatewaySettings().mode !== 'local') return;
  const foreignBuyerPort = foreignBuyerGuard().get();
  if (foreignBuyerPort !== null) {
    // Attaching would keep paying from the wallet the user just replaced.
    if (await portInUse(foreignBuyerPort)) throw new Error(foreignBuyerMessage(foreignBuyerPort));
    foreignBuyerGuard().clear();
  }
  if (isLocalRunning() && await probe(localGatewayOrigin())) {
    await verifyBuyerSigner();
    return;
  }
  startPromise ??= (async () => {
    // A stop (a switch to a remote gateway) overtakes this start: it must not
    // launch the local gateway afterwards, even mid-preparation.
    const generation = localStarts.begin();
    const cancelled = (): string | null => {
      if (closing) return CLOSING_ERROR;
      if (localStarts.overtaken(generation) || getGatewaySettings().mode !== 'local') return START_CANCELLED_ERROR;
      return null;
    };
    try {
      if (!isLocalRunning()) {
        signerVerified = false;
        await ensureSecureIdentity();
        // Never start on another wallet: without the signer key the CLI
        // would use or create a different identity.
        if (isStoredIdentityUnreadable()) {
          throw new Error(`Your signer key (${encryptedIdentityPath()}) can't be read by this version of the app, so the gateway won't start with a different wallet. A backup was saved next to it. Reopen the app, or reinstall the previous version to read it.`);
        }
        await startUnlessCancelled(cancelled, () => deps().processManager.start({
          mode: 'gateway',
          configPath: ACTIVE_CONFIG_PATH,
          ...(isDesktopDebugEnabled() ? { verbose: true } : {}),
          env: {
            ...(isDesktopDebugEnabled() ? { ANTSEED_DEBUG: '1' } : {}),
            // How ProcessManager asks it to stop on Windows; also stops it if the app crashes.
            [STOP_ON_STDIN_CLOSE_ENV]: '1',
            // A hard kill can leave that pipe open on Windows; the gateway also watches this process.
            [PARENT_PID_ENV]: String(process.pid),
            ...secureIdentityEnv(),
          },
        }).catch((err: unknown) => {
          if (!(err instanceof Error && err.message.includes('already running'))) throw err;
        }), () => deps().processManager.stop('gateway'));
      }
      // The gateway waits for its buyer (up to a minute) before it serves.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const why = cancelled();
        if (why) throw new Error(why);
        if (await probe(localGatewayOrigin(), 1_500)) {
          await verifyBuyerSigner();
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

async function localBuyerPort(): Promise<number> {
  const config = await readConfig(ACTIVE_CONFIG_PATH).catch(() => null);
  const port = (config as { buyer?: { proxyPort?: unknown } } | null)?.buyer?.proxyPort;
  return typeof port === 'number' ? port : DEFAULT_BUYER_PORT;
}

export async function stopLocalGateway(): Promise<void> {
  signerVerified = false;
  // Any start in flight is overtaken: it stops what it launched and fails.
  localStarts.end();
  await startPromise?.catch(() => undefined);
  await deps().processManager.stop('gateway');
}

/**
 * Throws when the local buyer pays from another wallet than the desktop's
 * signer: the gateway attaches to any buyer already on its port. A buyer that
 * can't be read yet is checked again on the next start or funding call.
 */
async function verifyBuyerSigner(): Promise<void> {
  if (signerVerified) return;
  await ensureSecureIdentity();
  const port = await localBuyerPort();
  const check = compareBuyerSigner(await liveBuyerAddress(port), getSecureIdentity()?.wallet.address ?? null);
  if (check === 'mismatch') {
    const message = buyerSignerMismatchMessage(port);
    lastError = message;
    throw new Error(message);
  }
  if (check === 'match') {
    signerVerified = true;
    if (lastError === buyerSignerMismatchMessage(port)) lastError = null;
  }
}

export const REMOTE_FUNDING_ERROR = 'This app uses a remote gateway, which pays from its own balance. Add funds in that gateway\'s console (Wallet).';

/**
 * Why the desktop's own wallet can't be funded now, or null when it can: a
 * remote gateway pays from its own balance, and a local buyer on another
 * wallet wouldn't see the deposit. Read fresh before each checkout or deposit address.
 */
export async function localFundingBlock(): Promise<string | null> {
  // An attach-only desktop (testbench) runs on a buyer that holds this app's wallet by construction.
  if (getGatewaySettings().mode !== 'local') return attachedGateway() ? null : REMOTE_FUNDING_ERROR;
  signerVerified = false;
  try {
    await verifyBuyerSigner();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** After importing a signer. Answers why the gateway can't use it yet, or null once it does. */
export async function restartLocalGatewayForNewIdentity(): Promise<string | null> {
  return restartForNewIdentity({
    local: getGatewaySettings().mode === 'local',
    stop: stopLocalGateway,
    start: ensureLocalGateway,
    buyerPort: localBuyerPort,
    portInUse,
    onForeignBuyer: (port) => { foreignBuyerGuard().set(port); },
  });
}

/** After a quit that didn't happen (an update that failed to install): the gateway may start again. */
export async function reopenLocalGateway(): Promise<void> {
  closing = false;
  await ensureLocalGateway();
}

/** For quitting: no gateway starts after this, and one that was starting is waited for and stopped. */
export async function closeLocalGateway(): Promise<void> {
  closing = true;
  // Waits for a start in flight, which stops what it launched.
  await stopLocalGateway();
}

async function runGatewayCli(args: string[]): Promise<string> {
  const result = await deps().processManager.runCliCommand(
    ['--config', ACTIVE_CONFIG_PATH, '--data-dir', resolveConnectDataDir(), 'gateway', ...args],
    'gateway',
    { logStdout: false },
  );
  return result.stdout;
}

async function runGatewayJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await runGatewayCli([...args, '--json'])) as T;
}

/** `key create` / `key rotate`: the new secret, and the key's id when the CLI gives one. */
async function runGatewayKeyCommand(args: string[]): Promise<{ id: string | null; secret: string }> {
  const parsed = await runGatewayJson<{ id?: unknown; apiKey?: unknown }>(args);
  if (typeof parsed.apiKey !== 'string' || !parsed.apiKey) throw new Error('The gateway did not return an API key');
  return { id: typeof parsed.id === 'string' ? parsed.id : null, secret: parsed.apiKey };
}

async function createLocalKey(label: string): Promise<StoredGatewayKey> {
  const { id, secret } = await runGatewayKeyCommand(['key', 'create', '--label', label]);
  return { id, label, secret };
}

async function revokeLocalKey(id: string): Promise<void> {
  await runGatewayCli(['key', 'revoke', id]).catch((err: unknown) => {
    deps().appendLog('gateway', 'system', `Could not revoke key ${id}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function readKeyRecord(id: string): Promise<KeyRecord> {
  return runGatewayJson<KeyRecord>(['key', 'show', id]);
}

/** True when the gateway rejects this key (revoked, expired, replaced, or the gateway's database was reset). */
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

/** The local key for `scope`, created on first use and re-created only if the gateway has lost it. */
async function ensureLocalKey(scope: string, appLabel?: string): Promise<StoredGatewayKey> {
  const pending = keyPromises.get(scope);
  if (pending) return pending;
  const promise = (async () => {
    const existing = getLocalKey(scope);
    if (existing && !(await keyRejected(localGatewayOrigin(), existing.secret))) return existing;
    if (existing) await assertKeyMayBeRecreated(existing, readKeyRecord);
    if (existing) deps().appendLog('gateway', 'system', `The gateway no longer accepts the "${existing.label}" key; creating a new one`);
    // A new key (first run, an app's own, replaced, or the gateway forgot the
    // old one) starts with no policy. In Private it can't be used until it has
    // one, or requests could reach any seller while the app says Private.
    const revoke = async (key: StoredGatewayKey) => { if (key.id) await revokeLocalKey(key.id); };
    const applyKeyPrivacy = async (key: StoredGatewayKey, mode: GatewayPrivacyMode): Promise<void> => {
      if (!key.id) throw new Error('The new key has no id on the gateway');
      await applyPrivacyToKey(key.id, mode);
    };
    const publish = () => publishUnderCurrentPrivacy(
      (mode) => publishKeyWithPolicy({
        create: () => createLocalKey(scopeLabel(scope, appLabel)),
        // A new key starts Anonymous: only Private needs a policy written first.
        applyPolicy: mode === 'private' ? (key) => applyKeyPrivacy(key, 'private') : null,
        revoke,
        save: (key) => setLocalKey(scope, key),
      }),
      () => getGatewaySettings().privacy,
      applyKeyPrivacy,
      async (key) => {
        deleteLocalKey(scope);
        await revoke(key);
      },
    );
    // An app's key is made in turn with privacy switches, so it is never saved
    // halfway through one: it starts under the mode the switch committed. The
    // desktop key is made outside that turn, since a switch needs it first.
    return scope === DESKTOP_KEY_SCOPE ? publish() : privacySwitches.run(publish);
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

/** Issues new secrets for every local key in use. Callers re-patch apps afterwards. */
export async function rotateLocalKeys(): Promise<void> {
  if (getGatewaySettings().mode !== 'local') throw new Error('Keys of a remote gateway are managed in its console');
  await ensureLocalGateway();
  // Unused keys that failed to revoke earlier get another try rather than a new secret.
  const unusedFailure = await revokeUnusedAppKeys().then(() => null, (err: unknown) => err);
  const usedScopes = listLocalKeys().map((entry) => entry.scope)
    .filter((target) => getGatewaySettings().keyMode === 'per-app' || target === DESKTOP_KEY_SCOPE);
  await rotateKeys(usedScopes, {
    get: getLocalKeyEntry,
    rotate: async (id) => {
      // The user asked for a working key, so here a revoked or expired one gives way to a new one.
      if (!keyIsUsable(await readKeyRecord(id))) {
        await revokeLocalKey(id);
        return null;
      }
      return (await runGatewayKeyCommand(['key', 'rotate', id])).secret;
    },
    save: (target, secret) => {
      const existing = getLocalKeyEntry(target);
      if (existing) setLocalKey(target, { ...existing, secret });
    },
    forget: retireLocalKey,
  });
  if (unusedFailure) throw unusedFailure;
}

/**
 * Revokes per-app keys that are no longer used (after switching back to one
 * shared key on the local gateway). One that can't be revoked stays saved for the next try, and the
 * failure is reported: it still works.
 */
export async function revokeUnusedAppKeys(): Promise<void> {
  const unused = unusedAppKeyScopes(getGatewaySettings(), listLocalKeys().map((entry) => entry.scope), DESKTOP_KEY_SCOPE);
  await rotateKeys(unused, {
    get: getLocalKeyEntry,
    rotate: async (id) => {
      await runGatewayCli(['key', 'revoke', id]);
      return null;
    },
    save: () => undefined,
    forget: retireLocalKey,
  });
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
  const parsed = await runGatewayJson<{ url?: unknown; setupRequired?: unknown; setupLink?: unknown }>(['console-link', '--port', String(DEFAULT_LOCAL_GATEWAY_PORT)]);
  if (parsed.setupRequired === true && typeof parsed.setupLink === 'string') return parsed.setupLink;
  const base = typeof parsed.url === 'string' ? parsed.url.replace(/\/$/, '') : `${localGatewayOrigin()}/console`;
  return `${base}${suffix}`;
}

/** A key's own gateway route (`/v1/key…`); `missing` when the gateway predates it. */
async function readKeyRoute(origin: string, apiKey: string, path: string): Promise<{ missing: true } | { missing: false; body: unknown }> {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(path.startsWith('/v1/key/rewards') ? 15_000 : 5_000),
  });
  if (response.status === 404) return { missing: true };
  if (!response.ok) throw new Error(`The gateway answered ${response.status} for ${path}`);
  return { missing: false, body: await response.json() };
}

async function readKeyInfo(origin: string, apiKey: string, fresh = false): Promise<GatewayKeyInfo | null> {
  const read = await readKeyRoute(origin, apiKey, `/v1/key${fresh ? '?fresh=1' : ''}`);
  return read.missing ? null : parseGatewayKeyInfo(read.body);
}

/** Secrets of every key this desktop made on its local gateway, besides the desktop key. */
function otherLocalKeySecrets(): string[] {
  return listLocalKeys()
    .filter((entry) => entry.scope !== DESKTOP_KEY_SCOPE)
    .flatMap((entry) => {
      const secret = getLocalKey(entry.scope)?.secret;
      return secret ? [secret] : [];
    });
}

/**
 * Usage of local keys the desktop retired, read as the gateway's owner:
 * their secrets are revoked, so `/v1/key` can't answer for them. Null when
 * there are none or the read fails.
 */
async function readRetiredUsage(): Promise<ReturnType<typeof parseRetiredUsage>> {
  const ids = listRetiredKeyIds();
  if (ids.length === 0) return null;
  return parseRetiredUsage(await runGatewayJson(['key', 'usage', ...ids]).catch(() => null));
}

/**
 * The desktop key's info from its gateway, local or remote, without summing
 * other keys: the balance the app spends from. `fresh` asks the gateway to
 * re-read the chain (after a deposit or before a payment decision).
 */
export async function getGatewayBalanceInfo(options: { fresh?: boolean } = {}): Promise<{ scope: string; info: GatewayKeyInfo | null }> {
  const { mode, origin, apiKey } = await getGatewayEndpoint();
  return { scope: gatewayKeyScope(mode, origin, apiKey), info: await readKeyInfo(origin, apiKey, options.fresh === true).catch(() => null) };
}

/**
 * The gateway and key the next balance read is for, from saved settings and
 * keys alone (it starts nothing), so the balance read cache can never answer
 * one key's read with another key's balance.
 */
export function currentBalanceScope(): string {
  const settings = getGatewaySettings();
  return settings.mode === 'remote'
    ? gatewayKeyScope('remote', settings.remoteUrl ?? '', getRemoteKey() ?? '')
    : gatewayKeyScope('local', localGatewayOrigin(), getLocalKey(DESKTOP_KEY_SCOPE)?.secret ?? '');
}

/**
 * The paying wallet's rewards, as the gateway (local or remote) reads them on
 * its own chain. `unsupported` when the gateway predates `/v1/key/rewards`;
 * null when it couldn't read them.
 */
export async function getGatewayKeyRewards(): Promise<GatewayRewardsSummary | null | 'unsupported'> {
  const { origin, apiKey } = await getGatewayEndpoint();
  const read = await readKeyRoute(origin, apiKey, '/v1/key/rewards');
  return read.missing ? 'unsupported' : parseKeyRewards(read.body);
}

/**
 * Retail vs paid from the gateway. On the local gateway it covers every key
 * the desktop made (the chat and apps with keys of their own), like Home's
 * request and spend tiles; on a remote one, the desktop's key. Null when the
 * gateway has none or predates `/v1/key/savings`.
 */
export async function getGatewayKeySavings(): Promise<{ origin: string; savings: GatewaySavings | null }> {
  const { mode, origin, apiKey } = await getGatewayEndpoint();
  const secrets = mode === 'local' ? [apiKey, ...otherLocalKeySecrets()] : [apiKey];
  const [answers, retired] = await Promise.all([
    Promise.all(secrets.map((secret) => readKeyRoute(origin, secret, '/v1/key/savings')
      .then((read) => (read.missing ? null : parseKeySavings(read.body)), () => null))),
    mode === 'local' ? readRetiredUsage() : Promise.resolve(null),
  ]);
  return { origin, savings: sumSavings([...answers, retired?.savings ?? null]) };
}

/**
 * What the gateway reports for the desktop key (`GET /v1/key`): caps and
 * paying wallet, with requests and spend over every local key the desktop
 * made, so apps with a key of their own count too.
 */
export async function getGatewayKeyInfo(): Promise<GatewayKeyInfo | null> {
  try {
    const { mode, origin, apiKey } = await getGatewayEndpoint();
    const desktop = await readKeyInfo(origin, apiKey);
    if (!desktop || mode !== 'local') return desktop;
    const [infos, retired] = await Promise.all([
      Promise.all(otherLocalKeySecrets().map((secret) => readKeyInfo(origin, secret).catch(() => null))),
      readRetiredUsage(),
    ]);
    // Apps that stopped using a key of their own keep their history in the totals.
    return withUsageOf(desktop, [...infos, retired?.usage ?? null].filter((usage): usage is KeyUsage => usage !== null));
  } catch {
    return null;
  }
}

type KeyPolicyView = { ownerRoutingPolicy: Record<string, unknown> | null; effective: Record<string, unknown> };

async function readKeyPolicy(id: string): Promise<KeyPolicyView> {
  const parsed = await runGatewayJson<Partial<KeyPolicyView>>(['key', 'policy', 'show', id]);
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

/**
 * The mode a send goes out under right now, from the saved settings (no
 * gateway round trip). Null for a remote gateway: its console owns the policy.
 */
export function currentPrivacyMode(): GatewayPrivacyMode | null {
  const settings = getGatewaySettings();
  return settings.mode === 'remote' ? null : settings.privacy;
}

/**
 * Anonymous or Private, as the desktop key's routing policy has it. Read in
 * turn with switches, so a read never lands in the middle of one. `changed`
 * when this read found the mode changed in the console and moved every key to
 * it; judged in turn too, so a switch that ran just before doesn't count.
 */
export function getGatewayPrivacy(): Promise<PrivacyRead> {
  return privacyInTurn(privacySwitches, readGatewayPrivacy, () => getGatewaySettings().privacy);
}

async function readGatewayPrivacy(): Promise<GatewayPrivacy> {
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
  // Private covers every app, so their keys follow before it is saved or shown.
  // A requirement the admins set on the desktop key alone is theirs to lift, so
  // that key is left as it is, but the apps' keys still follow: the app shows
  // Private, and Private covers every app.
  if (mode !== settings.privacy) await applyPrivacyToAllKeys(mode, key.id, { desktopKey: !requiredAbove });
  return { mode, editable: true, requiredAbove };
}

const privacySwitches = createSerialQueue();

/** Settles once no privacy switch is being applied. Sends that the renderer can't hold wait on it. */
export function whenPrivacySettled(): Promise<void> {
  return privacySwitches.whenSettled();
}

/**
 * One at a time: run together, two quick choices could land in either order.
 * `changed` when the switch moved the saved mode, judged in turn like a read.
 */
export function setGatewayPrivacy(mode: GatewayPrivacyMode): Promise<PrivacyRead> {
  return privacyInTurn(privacySwitches, () => applyGatewayPrivacy(mode), () => getGatewaySettings().privacy);
}

async function applyGatewayPrivacy(mode: GatewayPrivacyMode): Promise<GatewayPrivacy> {
  if (getGatewaySettings().mode === 'remote') throw new Error('A remote gateway\'s routing policy is set in its console');
  await ensureLocalGateway();
  const key = await ensureLocalKey(DESKTOP_KEY_SCOPE);
  if (!key.id) throw new Error('The desktop key has no id on the gateway');
  await applyPrivacyToAllKeys(mode, key.id);
  return readGatewayPrivacy();
}

/** The desktop key and every app's own key: Private is promised for the whole gateway. Then saved. */
function applyPrivacyToAllKeys(mode: GatewayPrivacyMode, desktopKeyId: string, { desktopKey = true }: { desktopKey?: boolean } = {}): Promise<void> {
  return applyPrivacyToKeys(
    mode,
    desktopKeyId,
    () => listLocalKeys().flatMap((entry) => (entry.id ? [entry.id] : [])),
    (id) => (id === desktopKeyId && !desktopKey ? Promise.resolve() : applyPrivacyToKey(id, mode)),
    () => updateGatewaySettings({ privacy: mode }),
  );
}
