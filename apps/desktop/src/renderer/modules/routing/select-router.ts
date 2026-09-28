import { createDesktopRouterSelection, routerPreferenceDefaults, type RouterPreferences, type RoutingServiceTarget, type RouterAllowedModel, routingServiceKey } from '../../../shared/routing-selection';
import type { RendererUiState } from '../../core/state';
import { notifyUiStateChanged } from '../../core/store';
import type { DesktopBridge } from '../../types/bridge';
import type { ChatModuleApi } from '../chat/controller';
import { loadVprRouterSettings, saveVprRouterSettings, saveVprRouteSelection } from './preferences';
import { applyVprRouteToConnectedProxy, syncBuyerDefaultRoute } from './proxy-sync';

export function selectVprRouter(
  bridge: DesktopBridge | undefined,
  state: RendererUiState,
  chat: Pick<ChatModuleApi, 'handleServiceChange' | 'endProvisionalDefaultModel'>,
  service: RoutingServiceTarget,
  preferences?: RouterPreferences,
  forConversation = false,
  allowedModels?: RouterAllowedModel[],
): void {
  const stored = preferences === undefined ? loadVprRouterSettings(service) : null;
  const advertised = state.vprRoutingServices.find(entry => routingServiceKey(entry) === routingServiceKey(service));
  const router = createDesktopRouterSelection(service,
    preferences ?? stored?.preferences ?? routerPreferenceDefaults(advertised?.catalog?.preferencesSchema),
    allowedModels ?? stored?.allowedModels);
  saveVprRouterSettings(router);
  state.vprRouteHydrated = true;
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
  preferences: RouterPreferences,
  allowedModels?: RouterAllowedModel[],
): void {
  const router = createDesktopRouterSelection(service, preferences, allowedModels);
  saveVprRouterSettings(router);
  if (!state.vprRouteSelection.router || routingServiceKey(state.vprRouteSelection.router.service) !== routingServiceKey(service)) return;
  state.vprRouteHydrated = true;
  state.vprRouteSelection = { ...state.vprRouteSelection, router };
  saveVprRouteSelection(state.vprRouteSelection);
  notifyUiStateChanged();
  void syncBuyerDefaultRoute(bridge, state);
}
