import type { ConfigFormData } from '../core/state';
import type { ChatPermissionMode, RawChatAttachment, ToolApprovalDecision } from '../types/bridge';

export type AppActions = {
  /** Restart the local gateway (and its buyer); connected apps stay connected across it. */
  restartConnect: () => Promise<void>;
  clearLogs: () => Promise<void>;
  saveConfig: (formData: ConfigFormData) => Promise<void>;
  startNewChat: () => void;
  openConversation: (id: string) => Promise<void>;
  sendMessage: (text: string, attachments?: RawChatAttachment[]) => void;
  sendMessageToConversation: (convId: string, text: string, attachments?: RawChatAttachment[]) => void;
  generateImage: (prompt: string) => void;
  abortChat: () => Promise<void>;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  /** Pick a gateway model in the chat dropdown (text: the chat's model; image: Send generates images). */
  selectChatModel: (modelId: string) => void;
  /** Reload the gateway's model list; `force` bypasses the one-minute cache. */
  refreshChatModels: (force?: boolean) => Promise<void>;
  privacyModeChosen: (mode: 'anonymous' | 'private') => void;
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
