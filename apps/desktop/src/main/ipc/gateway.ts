/**
 * IPC surface for the gateway: which one the desktop uses (local or remote),
 * its key mode, key rotation, and links into its console.
 */
import { clipboard, ipcMain, shell } from 'electron';
import {
  checkRemoteGateway,
  getGatewayEndpoint,
  getGatewayKeyInfo,
  getGatewayKeyRewards,
  getGatewayKeySavings,
  getGatewayPrivacy,
  setGatewayPrivacy,
  getGatewayStatus,
  gatewayConsoleUrl,
  revokeUnusedAppKeys,
  rotateLocalKeys,
  stopLocalGateway,
  ensureLocalGateway,
} from '../gateway/service.js';
import { clearGatewayModelCache } from '../gateway/models.js';
import { clearRoutePreviewCache } from '../gateway/route-preview.js';
import { invalidateCreditsCache } from '../payments/credits.js';
import {
  getGatewaySettings,
  hasRemoteKey,
  remoteGatewayFor,
  updateGatewaySettings,
} from '../gateway/settings.js';
import { reconnectAllApps } from '../connected-apps/patching/connection.js';
import { readPrivacy, switchPrivacy, type PrivacySwitchDeps } from '../gateway/privacy-switch.js';
import { findConnectableProfile } from '../connected-apps/patching/profiles.js';
import { openAgent } from '../agent-open.js';
import type { GatewayEndpointInfo, GatewaySettingsPatch } from '../../shared/gateway-types.js';
import { unreadRewardsSummary } from '../gateway/rewards.js';
import {
  agentSetupPrompt,
  installAgentSkills,
  listAgentSkillTargets,
  removeAgentSkills,
  syncAgentSkills,
} from '../agent-skills.js';
import { errorResult } from './results.js';

/** Agent skills get their own key in per-app key mode. */
const AGENT_SKILLS_APP = { name: 'agent-skills', label: 'Agent skills' };


export type GatewayIpcDeps = {
  /** The gateway or its key changed: the chat's model list must reload. */
  onEndpointChanged: () => void;
};

/** Re-points installed skills at the current gateway and key. Asks for no key when none are installed. */
export async function syncInstalledAgentSkills(): Promise<void> {
  if (!listAgentSkillTargets().some((target) => target.installed)) return;
  await syncAgentSkills(await getGatewayEndpoint(AGENT_SKILLS_APP));
}

/** The settings or keys changed, but the agents' installed skills still hold the old ones. */
export function skillsNotUpdated(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `Saved, but the Antseed skills installed in your agents couldn't be updated (${reason}). They still use the old key or address: add Antseed to those agents again in Agents & apps.`;
}

const NO_SAVINGS = { retailUsd: 0, paidUsd: 0, savedUsd: 0, matchedRequests: 0 } as const;

export function registerGatewayIpc(deps: GatewayIpcDeps): void {
  /** Re-points every consumer; says why when the installed agent skills couldn't follow (null when they did). */
  const endpointChanged = async (restartApps: boolean): Promise<string | null> => {
    clearGatewayModelCache();
    clearRoutePreviewCache();
    // The balance belonged to the old gateway or key: reads already started
    // for it finish under a key nobody asks for again.
    invalidateCreditsCache();
    deps.onEndpointChanged();
    await reconnectAllApps({ restart: restartApps });
    return syncInstalledAgentSkills().then(() => null, (err: unknown) => skillsNotUpdated(err));
  };

  ipcMain.handle('gateway:get-status', () => getGatewayStatus());

  ipcMain.handle('gateway:get-settings', () => ({ ...getGatewaySettings(), hasRemoteKey: hasRemoteKey() }));

  ipcMain.handle('gateway:update-settings', async (_event, opts: GatewaySettingsPatch) => {
    try {
      const patch = {
        ...(opts?.mode === 'local' || opts?.mode === 'remote' ? { mode: opts.mode } : {}),
        ...(opts?.remoteUrl !== undefined ? { remoteUrl: opts.remoteUrl } : {}),
        ...(opts?.remoteApiKey !== undefined ? { remoteApiKey: opts.remoteApiKey } : {}),
        ...(opts?.keyMode === 'shared' || opts?.keyMode === 'per-app' ? { keyMode: opts.keyMode } : {}),
      };
      // Checked before anything changes: a failed switch keeps the gateway that works.
      const remote = remoteGatewayFor(patch);
      if (remote) await checkRemoteGateway(remote);
      const before = getGatewaySettings();
      const after = updateGatewaySettings(patch);
      if (before.mode === 'local' && after.mode === 'remote') await stopLocalGateway();
      if (after.mode === 'local') await ensureLocalGateway();
      // The apps still have to follow the new settings if an old key couldn't be revoked.
      // Only a local gateway holds the per-app keys; a remote switch leaves them for the next local one.
      const cleanupFailure = after.mode === 'local'
        ? await revokeUnusedAppKeys().then(() => null, (err: unknown) => err)
        : null;
      const skillsFailure = await endpointChanged(true);
      if (cleanupFailure) return errorResult(cleanupFailure);
      if (skillsFailure) return { ok: false, error: skillsFailure };
      return { ok: true, settings: { ...getGatewaySettings(), hasRemoteKey: hasRemoteKey() } };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:rotate-keys', async () => {
    try {
      // Keys that were replaced before a failure still have to reach the apps.
      const failure = await rotateLocalKeys().then(() => null, (err: unknown) => err);
      const skillsFailure = await endpointChanged(true);
      if (failure) return errorResult(failure);
      return skillsFailure ? { ok: false, error: skillsFailure } : { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:get-endpoint', async (_event, opts?: { app?: string }): Promise<GatewayEndpointInfo> => {
    try {
      // In per-app key mode an app has its own key, which is the one to hand it.
      const profile = opts?.app ? findConnectableProfile(opts.app) : undefined;
      if (opts?.app && !profile) throw new Error(`Unknown app: ${opts.app}`);
      const endpoint = await getGatewayEndpoint(profile ? { name: profile.name, label: profile.label } : undefined);
      return { ok: true, baseUrl: `${endpoint.origin}/v1`, origin: endpoint.origin, apiKey: endpoint.apiKey, mode: endpoint.mode };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:get-key-info', () => getGatewayKeyInfo());

  const privacyDeps: PrivacySwitchDeps = {
    setPrivacy: setGatewayPrivacy,
    getPrivacy: getGatewayPrivacy,
    gatewayMode: () => getGatewaySettings().mode,
    // Previews and the model list cached under the old policy would show the
    // wrong sellers and prices.
    clearCaches: () => {
      clearRoutePreviewCache();
      clearGatewayModelCache();
    },
    // Each app's failure is recorded in its row; nothing else is left to report.
    refreshApps: () => { void reconnectAllApps({ freshModels: true }).catch(() => undefined); },
  };

  ipcMain.handle('gateway:get-privacy', async () => {
    try {
      return { ok: true, privacy: await readPrivacy(privacyDeps) };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:set-privacy', async (_event, opts: { mode?: string }) => {
    try {
      const mode = opts?.mode === 'private' ? 'private' : 'anonymous';
      return { ok: true, privacy: await switchPrivacy(mode, privacyDeps) };
    } catch (err) {
      return errorResult(err);
    }
  });

  // Rewards of the wallet paying for the app's key, read by its gateway
  // (local or remote) on the gateway's own chain.
  ipcMain.handle('gateway:get-rewards', async () => {
    try {
      const rewards = await getGatewayKeyRewards();
      if (rewards === 'unsupported') {
        // An older gateway has no rewards route: its own Rewards page has the figures.
        const address = (await getGatewayKeyInfo())?.buyerAddress ?? null;
        if (!address) throw new Error('Your gateway did not report its wallet');
        return { ok: true, data: unreadRewardsSummary(address) };
      }
      if (!rewards) throw new Error('Your gateway could not read rewards');
      return { ok: true, data: rewards };
    } catch (err) {
      return errorResult(err);
    }
  });

  // What the app's requests saved against retail prices, from its gateway.
  // "None" rather than a failed read (null) when the gateway has none, so an
  // earlier figure doesn't stay on screen.
  ipcMain.handle('gateway:get-savings', async () => {
    try {
      const { origin, savings } = await getGatewayKeySavings();
      return { ...(savings ?? NO_SAVINGS), gatewayOrigin: origin };
    } catch {
      return null;
    }
  });

  ipcMain.handle('agent-skills:list', () => listAgentSkillTargets());

  ipcMain.handle('agent-skills:install', async (_event, opts: { id?: string }) => {
    try {
      await installAgentSkills(String(opts?.id ?? ''), await getGatewayEndpoint(AGENT_SKILLS_APP));
      return { ok: true, targets: listAgentSkillTargets() };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('agent-skills:remove', async (_event, opts: { id?: string }) => {
    try {
      await removeAgentSkills(String(opts?.id ?? ''));
      return { ok: true, targets: listAgentSkillTargets() };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('agent-skills:open', async (_event, opts: { id?: string }) => {
    try {
      return await openAgent(String(opts?.id ?? ''));
    } catch (err) {
      return errorResult(err);
    }
  });

  // The prompt holds the key, so it goes straight to the clipboard.
  ipcMain.handle('agent-skills:copy-prompt', async () => {
    try {
      clipboard.writeText(agentSetupPrompt(await getGatewayEndpoint(AGENT_SKILLS_APP)));
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:open-console', async (_event, opts: { path?: string }) => {
    try {
      const pathname = typeof opts?.path === 'string' ? opts.path : '';
      if (pathname && !/^\/?[\w\-/?=&.]*$/.test(pathname)) throw new Error('Invalid console path');
      await shell.openExternal(await gatewayConsoleUrl(pathname));
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });
}
