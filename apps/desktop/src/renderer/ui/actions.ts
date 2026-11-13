import type { ConfigFormData } from '../core/state';
import type { ChatPermissionMode, ConversationFlags, RawChatAttachment, ToolApprovalDecision } from '../types/bridge';
import type { PrivacySwitchChoice } from '../modules/chat/controller';

export type AppActions = {
  /** Restart the local gateway (and its buyer); connected apps stay connected across it. */
  restartConnect: () => Promise<void>;
  clearLogs: () => Promise<void>;
  saveConfig: (formData: ConfigFormData) => Promise<void>;
  startNewChat: () => void;
  startNewChatOnModel: (modelId: string) => void;
  openConversation: (id: string) => Promise<void>;
  sendMessage: (text: string, attachments?: RawChatAttachment[], options?: { privateAtSubmit?: boolean }) => void;
  sendMessageToConversation: (convId: string, text: string, attachments?: RawChatAttachment[], options?: { privateAtSubmit?: boolean }) => void;
  generateImage: (prompt: string, options?: { privateAtSubmit?: boolean }) => void;
  abortChat: () => Promise<void>;
  /** Null once deleted; otherwise why not. */
  deleteConversation: (convId?: string) => Promise<string | null>;
  renameConversation: (convId: string, newTitle: string) => void;
  /** Pin or archive a chat; pinning unarchives it and archiving unpins it. */
  /** Null once saved; otherwise why not. */
  setConversationFlags: (convId: string, flags: ConversationFlags) => Promise<string | null>;
  /** Pick a gateway model in the chat dropdown (text: the chat's model; image: Send generates images). */
  selectChatModel: (modelId: string) => void;
  /** Reload the gateway's model list; `force` bypasses the one-minute cache. */
  refreshChatModels: (force?: boolean) => Promise<void>;
  privacyModeChosen: (mode: 'anonymous' | 'private', choice?: PrivacySwitchChoice) => void;
  privacySwitchLanded: (mode: 'anonymous' | 'private') => Promise<void>;
  setChatPermissionMode: (mode: ChatPermissionMode) => void;
  decideToolApproval: (decision: ToolApprovalDecision, requestId?: string) => void;
  /** Resend the last message of a chat that stopped for lack of funds. */
  retryAfterPayment: () => void;
  dismissFundsNotice: () => void;
  refreshCredits: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
};

let _actions: AppActions | null = null;

export function registerActions(actions: AppActions): void {
  _actions = actions;
}

export function getActions(): AppActions {
  if (!_actions) throw new Error('App actions not yet registered');
  return _actions;
}
