import type { RendererUiState } from '../../core/state';
import type { DesktopBridge, RuntimeProcessState } from '../../types/bridge';
import { chooseBestVprRoute } from './select';
import { routesForSelectedModel } from '../catalog/view-models';
import { CODING_ONLY_SUFFIX_RE } from '../catalog/model-identity';
import { activeProfilesFromRuntimeState, buildVprPeerOptions } from './tools';

declare const __ANTSEED_SYSTEM_PROXY_PORT__: number;

const SYSTEM_PROXY_PORT = __ANTSEED_SYSTEM_PROXY_PORT__;

export type VprRouteTarget = {
  peerId: string;
  model: string;
  servedModels: string[];
};

export function buyerDefaultRoutePayload(
  selection: RendererUiState['vprRouteSelection'],
  target: VprRouteTarget,
): { peerId?: string; service: string } {
  if (selection.mode === 'pinned-peer') {
    return { peerId: target.peerId, service: target.model };
  }
  return { service: target.model };
}

/** Resolve the current AI VPN selection to a concrete peer + model target. */
function resolveRouteTarget(uiState: RendererUiState): VprRouteTarget | null {
  const selection = uiState.vprRouteSelection;
  if (!selection.model) return null;
  const selectedEntry = uiState.vprModelCatalog.find((entry) => (
    entry.provider === selection.model?.provider && entry.serviceId === selection.model.serviceId
  ));
  // Connected apps and the buyer's default alias currently issue text/chat
  // requests. Leave their existing route untouched when AI VPN selects an image
  // model; chat's per-conversation selection remains the text fallback.
  if (selectedEntry?.kind === 'image') return null;
  const canonicalServiceId = selectedEntry?.serviceId ?? selection.model.serviceId;
  const modelRoutes = routesForSelectedModel(uiState.vprRoutableRows, selection.model);
  const unrestrictedRoutes = modelRoutes.filter((candidate) => !CODING_ONLY_SUFFIX_RE.test(candidate.serviceId));
  const routes = selection.mode === 'pinned-peer' ? modelRoutes : unrestrictedRoutes;
  const route = selection.mode === 'pinned-peer' && selection.peerId
    ? routes.find((candidate) => candidate.peerId === selection.peerId) ?? null
    : chooseBestVprRoute(routes, uiState.vprRoutingPreferences);
  const peerId = (selection.mode === 'pinned-peer' && selection.peerId) || route?.peerId || null;
  if (!peerId) return null;

  // Routes aggregate serviceId variants of the model — send the id the
  // chosen peer actually advertises, not the selection's representative.
  const model = route?.serviceId ?? canonicalServiceId;
  const peerOptions = buildVprPeerOptions(uiState.lastPeers, uiState.vprRoutableRows);
  const services = peerOptions.find((peer) => peer.peerId === peerId)?.services ?? [];
  // The resolved model must always be in the served list — main's route
  // computation drops the default model when the list doesn't contain it.
  const servedModels = services.includes(model) ? services : [...services, model];
  return { peerId, model, servedModels };
}

async function activeProfileNames(bridge: DesktopBridge): Promise<string[]> {
  try {
    const state = (await bridge.systemProxyGetState?.()) ?? null;
    return [...(activeProfilesFromRuntimeState(state) ?? [])];
  } catch {
    return [];
  }
}

async function startProfilesOnRoute(
  bridge: DesktopBridge,
  target: VprRouteTarget,
  profileNames: string[],
  profileSwitch: boolean,
): Promise<{ ok: boolean; state?: RuntimeProcessState | null; error?: string }> {
  if (!bridge.systemProxyStart) return { ok: false, error: 'System proxy is unavailable in this build' };
  try {
    const result = await bridge.systemProxyStart({
      peerId: target.peerId,
      port: SYSTEM_PROXY_PORT,
      profiles: profileNames,
      defaultModel: target.model,
      servedModels: target.servedModels,
      toolRoutes: Object.fromEntries(profileNames.map((name) => [name, { peerId: target.peerId, model: target.model }])),
      profileSwitch,
    });
    return { ok: result.ok, state: result.state ?? null, ...(result.error ? { error: result.error } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push the current AI VPN selection to the buyer proxy's default route
 * (`POST /_antseed/route`), keeping the proxy the single routing authority:
 * the `antseed` model alias and headless frontends (the Telegram bridge)
 * resolve their peer from this route instead of re-deriving it. Best-effort —
 * main dedupes repeat values and the buyer proxy may not be running yet, so
 * this is safe to call from polling refreshes.
 */
export async function syncBuyerDefaultRoute(
  bridge: DesktopBridge | undefined,
  uiState: RendererUiState,
): Promise<void> {
  if (!bridge?.chatSetBuyerDefaultRoute) return;
  const target = resolveRouteTarget(uiState);
  if (!target) return;
  await bridge.chatSetBuyerDefaultRoute(
    buyerDefaultRoutePayload(uiState.vprRouteSelection, target),
  ).catch(() => undefined);
}

/**
 * Re-point the running system proxy at the current AI VPN route selection.
 *
 * Without this, changing the default model (Home dropdown, model view Apply,
 * floating pill) re-pins the buyer to the new model's peer while connected
 * app profiles keep the served-models list and default model captured at
 * connect time — apps then request models the newly pinned peer doesn't
 * serve ("Service X is not served by this peer").
 *
 * Text selections update the buyer default route; image selections leave the
 * existing text route untouched. The profile restart below is a no-op when no
 * app profile is connected. Per-app route overrides
 * made in the Apps view are reset to the new default route; adjust them there
 * afterwards if needed.
 */
export async function applyVprRouteToConnectedProxy(
  bridge: DesktopBridge | undefined,
  uiState: RendererUiState,
): Promise<void> {
  if (!bridge) return;
  void syncBuyerDefaultRoute(bridge, uiState);
  const profileNames = await activeProfileNames(bridge);
  if (profileNames.length === 0) return;
  const target = resolveRouteTarget(uiState);
  if (!target) return;
  await startProfilesOnRoute(bridge, target, profileNames, true);
}

/**
 * Connect a single app profile on the current AI VPN route (joining any
 * profiles already connected). Used by the Home screen's one-click app
 * buttons.
 */
export async function connectVprProfile(
  bridge: DesktopBridge | undefined,
  uiState: RendererUiState,
  profileName: string,
): Promise<{ ok: boolean; state?: RuntimeProcessState | null; error?: string }> {
  if (!bridge) return { ok: false, error: 'Desktop bridge unavailable' };
  const target = resolveRouteTarget(uiState);
  if (!target) return { ok: false, error: 'No model route available yet' };
  const existing = await activeProfileNames(bridge);
  const profileNames = Array.from(new Set([...existing, profileName]));
  return startProfilesOnRoute(bridge, target, profileNames, existing.length > 0);
}
