import { createDesktopRouterSelection, type RoutingServiceTarget, type RouterAllowedModel, routingServiceKey } from '../../../shared/routing-selection';
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
