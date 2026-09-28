import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@antseed/ui/styles';
import '../src/renderer/global.scss';
import { createInitialUiState } from '../src/renderer/core/state';
import { initStore, notifyUiStateChanged } from '../src/renderer/core/store';
import { initChatModule } from '../src/renderer/modules/chat/controller';
import { loadVprRouteSelection } from '../src/renderer/modules/routing/preferences';
import { selectVprRouter, updateVprRouterSettings } from '../src/renderer/modules/routing/select-router';
import { registerActions, type AppActions } from '../src/renderer/ui/actions';
import { shallowEqual, useUiSelector } from '../src/renderer/ui/hooks/useUiSelector';
import { VprModelDropdown } from '../src/renderer/ui/components/chat/VprModelDropdown';
import { ChatBubble } from '../src/renderer/ui/components/chat/ChatBubble';
import type { ChatMessage } from '../src/renderer/ui/components/chat/chat-shared';
import { VprExploreView } from '../src/renderer/ui/components/views/VprExploreView';
import { VprModelView } from '../src/renderer/ui/components/views/VprModelView';
import type { ViewName } from '../src/renderer/ui/types';
import type { DesktopBridge } from '../src/renderer/types/bridge';
import { favoriteModelKey, loadFavoriteModels, toggleFavoriteModel } from '../src/renderer/modules/catalog/favorites';

const state = createInitialUiState();
for (const serviceId of ['model-a', 'model-b']) {
  if (!loadFavoriteModels().has(favoriteModelKey('fake-inference', serviceId))) toggleFavoriteModel('fake-inference', serviceId);
}
state.vprRouteSelection = loadVprRouteSelection(state.vprRouteSelection);
state.vprRoutingPreferences.minTrustScore = 0;
initStore(state);
const conversations = new Map<string, { id: string; service: string; provider?: string; peerId?: string; routeMode?: string; messages: unknown[] }>();
const responses: ChatMessage[] = [];
const json = async (path: string, body?: unknown) => (await fetch(path, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();
const bridge: DesktopBridge = {
  chatGetBuyerDefaultRoute: () => json('/_antseed/route'),
  chatSetBuyerDefaultRoute: (payload) => json('/_antseed/route', payload),
  chatGetRoutingServices: () => json('/_antseed/routing-services'),
  chatAiGetProxyStatus: async () => ({ ok: true, data: { running: true, port: 8377 } }),
  chatAiListDiscoverRows: async () => {
    const catalog = await json('/v1/models');
    return { ok: true, data: catalog.data.flatMap((entry: { name: string; peers: Record<string, unknown>[] }) => entry.peers.map((peer) => ({
      ...peer, serviceLabel: entry.name, peerLabel: peer.peerId, effectiveReputationScore: 100,
    }))) };
  },
  chatAiListConversations: async () => ({ ok: true, data: [...conversations.values()] }),
  chatAiCreateConversation: async (service, provider, peerId, routeMode) => {
    const conversation = { id: crypto.randomUUID(), service, provider, peerId, routeMode, messages: [] };
    conversations.set(conversation.id, conversation);
    return { ok: true, data: conversation };
  },
  chatAiGetConversation: async (id) => ({ ok: true, data: conversations.get(id) }),
  chatAiSelectPeer: async (payload) => {
    const conversation = payload.conversationId ? conversations.get(payload.conversationId) : null;
    if (conversation && (payload.service === 'antseed' || payload.service === 'levanto-auto')) {
      await json('/_antseed/conversations/update', { id: `vpr:${conversation.id}`, pinnedModel: null, peerSource: 'auto' });
    }
    if (conversation) Object.assign(conversation, { service: payload.service, provider: payload.provider, peerId: payload.peerId, routeMode: payload.routeMode });
    return { ok: true };
  },
  chatAiSend: async (id, message, service, _provider, _attachments, peerId) => {
    const response = await fetch('/v1/chat/completions', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-vpr-session-id': id, ...(peerId ? { 'x-antseed-pin-peer': peerId } : {}),
    }, body: JSON.stringify({ model: service, messages: [{ role: 'user', content: message }] }) });
    const result = await response.json();
    responses.push({ role: 'assistant', content: response.ok ? result.choices[0].message.content : result.error.message,
      meta: response.ok ? { service: result.model } : undefined });
    notifyUiStateChanged();
    return { ok: response.ok, error: result.error?.message };
  },
};
const chat = initChatModule({ bridge, uiState: state, appendSystemLog: () => {} });
registerActions(new Proxy({
  selectVprRouter: (service, preferences, forConversation, allowedModels) => selectVprRouter(bridge, state, chat, service, preferences, forConversation, allowedModels),
  updateVprRouterSettings: (service, preferences, allowedModels) => updateVprRouterSettings(bridge, state, service, preferences, allowedModels),
} as Partial<AppActions>, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as AppActions);

function Harness() {
  const snapshot = useUiSelector((current) => ({ ...current, responseCount: responses.length }), shallowEqual);
  const [message, setMessage] = useState('Hello from VPR');
  const [view, setView] = useState<ViewName>('chat');
  return <main style={{ maxWidth: 760, margin: '64px auto', padding: 24 }}>
    <h1>VPR routing E2E</h1>
    <p>Production picker and chat controller · real buyer HTTP and P2P · fake upstream services</p>
    <nav><button onClick={() => setView('explore')}>Models</button><button onClick={() => setView('chat')}>Chat</button></nav>
    {view === 'explore' ? <VprExploreView onSelectView={setView} /> : view === 'model' ? <VprModelView onSelectView={setView} /> : <>
    <VprModelDropdown catalog={snapshot.vprModelCatalog} kind="text"
      selectedProvider={snapshot.vprRouteSelection.model?.provider ?? ''}
      selectedServiceId={snapshot.vprRouteSelection.model?.serviceId ?? ''}
      routerActive={!!snapshot.vprRouteSelection.router} fallbackLabel="Choose model or router" disabled={false}
      onBrowseAll={() => setView('explore')} onSelect={(entry) => chat.handleServiceChange(`${entry.provider}\u0001${entry.serviceId}`, undefined, false, 'auto')} />
    <button onClick={() => void chat.refreshChatServiceOptions()}>Refresh catalog</button>
    <button onClick={() => chat.startNewChat()}>New chat</button>
    <label>Message <input aria-label="Message" value={message} onChange={(event) => setMessage(event.target.value)} /></label>
    <button disabled={snapshot.chatSending} onClick={() => chat.sendMessage(message)}>Send</button>
    <div role="log">{responses.map((response, index) => <ChatBubble key={index} message={response} />)}</div>
    </>}
    {snapshot.vprRouteError && <p role="alert">{snapshot.vprRouteError}</p>}
    {snapshot.chatError && <p role="alert">{snapshot.chatError}</p>}
    <output aria-label="Route state">{JSON.stringify(snapshot.vprRouteSelection)}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
await chat.refreshChatServiceOptions();
await chat.refreshChatProxyStatus();
