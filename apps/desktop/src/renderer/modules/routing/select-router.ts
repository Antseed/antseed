import { modelRouteTotalPrice } from '@antseed/node/model-routing';
import { createDesktopRouterSelection, isDesktopRouterSelection, type DesktopRouterSelection, type RoutingServiceEntry, type RoutingServiceTarget, type RouterAllowedModel, routingServiceKey } from '../../../shared/routing-selection';
import type { DiscoverRow, RendererUiState, VprRoutingPreferences } from '../../core/state';
import { notifyUiStateChanged } from '../../core/store';
import type { DesktopBridge } from '../../types/bridge';
import type { ChatModuleApi } from '../chat/controller';
import { loadVprRouterSettings, saveVprRouterSettings, saveVprRouteSelection } from './preferences';
import { applyVprRouteToConnectedProxy, syncBuyerDefaultRoute } from './proxy-sync';
import { isPeerRoutable } from './select';

/** Provider id of AntSeed's free model-routing service (`@antseed/provider-default-router`). */
export const FREE_DEFAULT_ROUTER_PROVIDER = 'default-router';

/**
 * The free default router a new user starts on, or null when none qualifies.
 * It must be a free `default-router` service from a peer the access rules
 * allow, whose model list is non-empty and only holds models some allowed
 * seller offers for free, so a router that steers to paid models never
 * becomes the default.
 */
export function findFreeDefaultRouter(
  services: readonly RoutingServiceEntry[],
  rows: readonly DiscoverRow[],
  preferences: VprRoutingPreferences,
): RoutingServiceEntry | null {
  const freeModels = new Set(rows
    .filter((row) => modelRouteTotalPrice(row) === 0 && !row.cachedInputUsdPerMillion && isPeerRoutable(row.peerId, preferences))
    .map((row) => JSON.stringify([row.provider, row.serviceId])));
  const candidates = services.filter((service) => service.provider === FREE_DEFAULT_ROUTER_PROVIDER
    && Number(service.priceMicroUsdc) === 0
    && isPeerRoutable(service.peerId, preferences)
    && !!service.catalog?.models.length
    && service.catalog.models.every((model) => freeModels.has(JSON.stringify([model.provider, model.serviceId]))));
  return [...candidates].sort((a, b) => routingServiceKey(a).localeCompare(routingServiceKey(b)))[0] ?? null;
}

/** Make the free default router the selection without counting it as a user choice. */
export function adoptFreeDefaultRouter(state: RendererUiState, service: RoutingServiceTarget): void {
  const stored = loadVprRouterSettings(service);
  const router = createDesktopRouterSelection(service, stored?.costQualityTradeoff, stored?.allowedModels);
  saveVprRouterSettings(router);
  state.vprRouteSelection = { model: null, mode: 'auto', peerId: null, router };
  saveVprRouteSelection(state.vprRouteSelection);
  notifyUiStateChanged();
}

export function selectVprRouter(
  bridge: DesktopBridge | undefined,
  state: RendererUiState,
  chat: Pick<ChatModuleApi, 'handleServiceChange' | 'endProvisionalDefaultModel'>,
  service: RoutingServiceTarget,
  costQualityTradeoff?: number,
  forConversation = false,
  allowedModels?: RouterAllowedModel[],
): void {
  const stored = costQualityTradeoff === undefined ? loadVprRouterSettings(service) : null;
  const router = createDesktopRouterSelection(service,
    costQualityTradeoff ?? stored?.costQualityTradeoff,
    allowedModels ?? stored?.allowedModels);
  saveVprRouterSettings(router);
  if (forConversation) chat.handleServiceChange('antseed', undefined, false, 'auto');
  state.vprRouteSelection = { model: null, mode: 'auto', peerId: null, router };
  state.chatImageRouteSelection = null;
  chat.endProvisionalDefaultModel();
  saveVprRouteSelection(state.vprRouteSelection);
  notifyUiStateChanged();
  void applyVprRouteToConnectedProxy(bridge, state);
}

export function updateVprRouterSettings(
  bridge: DesktopBridge | undefined,
  state: RendererUiState,
  service: RoutingServiceTarget,
  costQualityTradeoff: number | undefined,
  allowedModels?: RouterAllowedModel[],
): void {
  const router = createDesktopRouterSelection(service, costQualityTradeoff, allowedModels);
  saveVprRouterSettings(router);
  if (!state.vprRouteSelection.router || routingServiceKey(state.vprRouteSelection.router.service) !== routingServiceKey(service)) return;
  state.vprRouteSelection = { ...state.vprRouteSelection, router };
  saveVprRouteSelection(state.vprRouteSelection);
  notifyUiStateChanged();
  void syncBuyerDefaultRoute(bridge, state);
}

/** Adopt a router saved in the buyer proxy by another client, without writing it back. */
export function adoptExternalVprRouter(state: RendererUiState, value: DesktopRouterSelection): boolean {
  if (!isDesktopRouterSelection(value)) return false;
  const router = createDesktopRouterSelection(value.service, value.costQualityTradeoff, value.allowedModels);
  saveVprRouterSettings(router);
  state.vprRouteSelection = { model: null, mode: 'auto', peerId: null, router };
  state.chatImageRouteSelection = null;
  state.vprRouteError = null;
  saveVprRouteSelection(state.vprRouteSelection);
  notifyUiStateChanged();
  return true;
}
