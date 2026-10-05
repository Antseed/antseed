import type { ConfigFormData, VprPeerListing, VprRoutingPreferences } from '../core/state';
import type { ChatPermissionMode, RawChatAttachment, ToolApprovalDecision } from '../types/bridge';

export type AppActions = {
  startConnect: () => Promise<void>;
  stopConnect: () => Promise<void>;
  /** Stop + start the buyer; connected apps stay connected across it. */
  restartConnect: () => Promise<void>;
  startAll: () => Promise<void>;
  stopAll: () => Promise<void>;
  refreshAll: () => Promise<void>;
  clearLogs: () => Promise<void>;
  scanDht: () => Promise<void>;
  saveConfig: (formData: ConfigFormData) => Promise<void>;
  createNewConversation: () => Promise<void>;
  startNewChat: () => void;
  openConversation: (id: string) => Promise<void>;
  sendMessage: (text: string, attachments?: RawChatAttachment[]) => void;
  sendMessageToConversation: (convId: string, text: string, attachments?: RawChatAttachment[]) => void;
  generateImage: (prompt: string) => void;
  abortChat: () => Promise<void>;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  handleServiceChange: (value: string, explicitPeerId?: string) => void;
  handleServiceFocus: () => void;
  handleServiceBlur: () => void;
  clearPinnedPeer: () => void;
  selectVprModel: (provider: string, serviceId: string, peerId?: string | null) => void;
  clearVprPinnedPeer: () => void;
  /**
   * Remember (or forget, with null) a seller pin for a model without applying
   * the model — used while browsing a model page that isn't the active route.
   * selectVprModel picks the remembered pin up when the model is applied.
   */
  setVprModelSellerPin: (provider: string, serviceId: string, peerId: string | null) => void;
  updateVprRoutingPreferences: (patch: Partial<VprRoutingPreferences>) => void;
  setVprPeerListing: (peerId: string, listing: VprPeerListing) => void;
  setChatPermissionMode: (mode: ChatPermissionMode) => void;
  decideToolApproval: (decision: ToolApprovalDecision, requestId?: string) => void;
  acceptReminderHome: () => void;
  dismissReminderHome: () => void;
  rejectPaymentSession: () => void;
  retryAfterPayment: () => void;
  refreshCredits: () => Promise<void>;
  refreshPaymentSummary: (force?: boolean) => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  refreshPlugins: () => Promise<void>;
  installPlugin: () => Promise<void>;
  /** Open the floating pill (always lands with the chat dropdown expanded). */
  openVprFloat?: (profileName?: string) => Promise<void>;
  closeVprFloat?: () => Promise<void>;
  setVprFloatAutoOpen?: (enabled: boolean) => void;
  /** Debug aid: name the routed seller next to the model on the pill's chat rows. */
  setVprFloatShowRoutedPeer?: (enabled: boolean) => void;
};

let _actions: AppActions | null = null;

export function registerActions(actions: AppActions): void {
  _actions = actions;
}

export function getActions(): AppActions {
  if (!_actions) throw new Error('App actions not yet registered');
  return _actions;
}
