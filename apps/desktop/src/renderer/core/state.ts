import type {
  DaemonStateSnapshot,
  LogEvent,
  RuntimeProcessState,
} from '../types/bridge';
import type { ChatMessage } from '../ui/components/chat/chat-shared';
import type { ChatModel, ChatPermissionMode, ToolApprovalRequest } from '../types/bridge';

export type BadgeTone = 'active' | 'idle' | 'warn' | 'bad';

export type BadgeState = {
  tone: BadgeTone;
  label: string;
};

export type SortDirection = 'asc' | 'desc';

export type SortState = {
  key: string;
  dir: SortDirection;
};

export type PluginHints = {
  router: string | null;
};

export type PeerEntry = {
  peerId: string;
  displayName: string | null;
  host: string;
  port: number;
  providers: string[];
  services: string[];
  /** Services this peer serves for $0 per its fetched pricing matrix — empty
      until the peer's metadata has actually been resolved. */
  freeServices: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  onChainReputationScore: number | null;
  lastSeen: number;
  lastReachedAt: number | null;
  source: string;
  online: boolean;
};

export type ConfigFormData = {
  proxyPort: number;
  peerRefreshIntervalMs: number;
  maxInputUsdPerMillion: number;
  maxOutputUsdPerMillion: number;
  minRep: number;
  disableMetadataV2Services: boolean;
  paymentMethod: string;
  devMode: boolean;
  cryptoChainId: string;
};

export type ActiveChannelInfo = {
  reservedUsdc: string;
  peerName: string;
};

export type RendererUiState = {
  // --- Process / runtime state ---
  processes: RuntimeProcessState[];
  refreshing: boolean;
  daemonState: DaemonStateSnapshot | null;

  // --- Runtime display ---
  connectBadge: BadgeState;
  runtimeActivity: { tone: BadgeTone; message: string };

  // --- Logs ---
  logs: LogEvent[];

  // --- Network reachability alert ---
  /** 'blocked' = internet up but DHT unreachable (firewall/VPN dropping UDP);
      'no-peers' = on the DHT but discovery sweeps keep coming back empty. */
  networkAlert: 'none' | 'no-internet' | 'blocked' | 'no-peers';
  /** Live DHT routing-table size from the buyer's status poll — the first
      network signal that moves during startup, so the setup screen can show
      bootstrap progress before any peer or service is discovered. */
  dhtNodeCount: number;

  // --- Overview display ---
  overviewBadge: BadgeState;
  ovNodeState: string;
  ovPeers: string;
  ovDhtHealth: string;
  ovProxyPort: string;
  ovServiceCount: string;
  ovLastScan: string;
  ovPeersCount: string;
  overviewPeers: PeerEntry[];

  // --- Peers display ---
  peersMessage: string;
  lastPeers: PeerEntry[];
  peerSort: SortState;
  lastDebugKey: string;

  // --- Connection display ---
  connectionMeta: BadgeState;
  connectionStatus: string;
  connectionNetwork: string;
  connectionSources: string;
  connectionNotes: string;

  // --- Config display ---
  configMessage: { text: string; type: 'success' | 'error' | 'info' } | null;
  configFormData: ConfigFormData | null;
  configSaving: boolean;
  devMode: boolean;

  // --- Plugin setup ---
  installedPlugins: Set<string>;
  pluginHints: PluginHints;
  pluginInstallBusy: boolean;

  // --- Credits / Payments ---
  /** Unreserved deposits — what a new channel reserve or a withdrawal draws on.
      Payment gating reads this; the headline balance does not. */
  creditsAvailableUsdc: string;
  creditsReservedUsdc: string;
  /** Everything on deposit (available + reserved). */
  creditsTotalUsdc: string;
  /** Signed but not yet settled on-chain — spent in every sense but the ledger's. */
  creditsPendingUsdc: string;
  /** Deposits minus pending spend; used for spending and low-funds decisions. */
  creditsSpendableUsdc: string;
  /** USDC waiting in the buyer wallet before it can be swept into deposits. */
  creditsWalletUsdc: string;
  /** Spendable deposits plus wallet USDC. Used by balance headlines. */
  creditsTotalOwnedUsdc: string;
  creditsCreditLimitUsdc: string;
  /** Contract floor for the first deposit (net of the relay fee). */
  creditsMinFirstDepositUsdc: string;
  /** Relay fee taken from each wallet sweep into credits. */
  creditsDepositFeeUsdc: string;
  /** False until the deposits balance has been read; the amounts are placeholders until then. */
  creditsBalanceKnown: boolean;
  creditsEvmAddress: string | null;
  creditsOperatorAddress: string | null;

  // --- Agent access / tool approval ---
  chatPermissionMode: ChatPermissionMode;
  chatToolApprovalRequests: ToolApprovalRequest[];
  chatToolApprovalRequest: ToolApprovalRequest | null;

  // --- Active payment channels (keyed by peerId) ---
  chatActiveChannels: Map<string, ActiveChannelInfo>;

  // --- Chat display ---
  chatActiveConversation: string | null;
  chatOpeningConversationId: string | null;
  chatConversations: unknown[];
  chatConversationsLoaded: boolean;
  /** Buyer proxy port answered the last reachability probe. */
  chatProxyOnline: boolean;
  /** Chat opens thin (compact window, no conversation list). The header
      toggle expands the window to the standard preset and shows the panel. */
  chatPanelExpanded: boolean;
  chatMessages: unknown[];
  chatStreamingMessage: ChatMessage | null;
  chatSending: boolean;
  chatSendingConversationId: string | null;
  /** IDs of all conversations currently running a request, across the whole app. */
  chatSendingConversationIds: string[];
  chatError: string | null;
  /**
   * The last request failed because the gateway could not pay for it (HTTP
   * 402 / insufficient funds). Rendered as a calm notice, not an error;
   * `canAddFunds` is false for a key spend limit, which funding won't lift.
   */
  chatFundsNotice: { message: string; canAddFunds: boolean } | null;
  /** Gateway models for the chat picker, one row per model id. */
  chatModels: ChatModel[];
  /** A model list has arrived at least once (empty or not). */
  chatModelsLoaded: boolean;
  chatModelsLoading: boolean;
  /** Why the last model list failed (gateway unreachable, 401, not configured); null when it loaded. */
  chatModelsError: string | null;
  /** Text model the composer sends with: the open conversation's, else the new-chat default. */
  chatSelectedModelId: string;
  /** Image model picked in the dropdown; while set, Send generates an image. */
  chatImageModelId: string | null;
  chatInputDisabled: boolean;
  chatSendDisabled: boolean;
  chatAbortVisible: boolean;

  // --- Browser preview ---
  browserPreviewUrl: string | null;
  browserPreviewRequestId: number;
  chatWorkspacePath: string;
  chatWorkspaceDefaultPath: string;

  // --- Streaming indicator ---
  chatThinkingElapsedMs: number;
  chatWaitingForStream: boolean;
  chatThinkingPhase: string | null;

  // --- Router input value (for plugin setup + chat) ---
  connectRouterValue: string;
  dashboardPortValue: string;

  // --- First-run setup ---
  appSetupStatusKnown: boolean;
  appSetupNeeded: boolean;
  appSetupComplete: boolean;
  appSetupStep: string;
};

const MAX_LOGS = 2000;

export function createInitialUiState(): RendererUiState {
  return {
    // Process / runtime
    processes: [],
    refreshing: false,
    daemonState: null,

    // Runtime display
    connectBadge: { tone: 'bad', label: 'Stopped' },
    runtimeActivity: { tone: 'idle', message: 'Idle' },

    // Logs
    logs: [],

    // Network reachability alert
    networkAlert: 'none',
    dhtNodeCount: 0,

    // Overview
    overviewBadge: { tone: 'idle', label: 'Idle' },
    ovNodeState: 'idle',
    ovPeers: '0',
    ovDhtHealth: 'Down',
    ovProxyPort: '-',
    ovServiceCount: '0',
    ovLastScan: 'n/a',
    ovPeersCount: '0',
    overviewPeers: [],

    // Peers
    peersMessage: 'Loading peer visibility...',
    lastPeers: [],
    peerSort: { key: 'reputation', dir: 'desc' },
    lastDebugKey: '',

    // Connection
    connectionMeta: { tone: 'idle', label: 'No data' },
    connectionStatus: 'No status data.',
    connectionNetwork: 'No network stats.',
    connectionSources: 'No data source info.',
    connectionNotes: 'No notes.',

    // Config
    configMessage: null,
    configFormData: null,
    configSaving: false,
    devMode: false,

    // Plugin setup
    installedPlugins: new Set<string>(),
    pluginHints: { router: null },
    pluginInstallBusy: false,

    // Credits / Payments
    creditsAvailableUsdc: '0',
    creditsReservedUsdc: '0',
    creditsTotalUsdc: '0',
    creditsPendingUsdc: '0',
    creditsSpendableUsdc: '0',
    creditsWalletUsdc: '0',
    creditsTotalOwnedUsdc: '0',
    creditsCreditLimitUsdc: '0',
    creditsMinFirstDepositUsdc: '1',
    creditsDepositFeeUsdc: '0.05',
    creditsBalanceKnown: false,
    creditsEvmAddress: null,
    creditsOperatorAddress: null,

    // Agent access / tool approval
    chatPermissionMode: 'manual',
    chatToolApprovalRequests: [],
    chatToolApprovalRequest: null,

    // Active payment channels
    chatActiveChannels: new Map(),

    // Chat
    chatActiveConversation: null,
    chatOpeningConversationId: null,
    chatConversations: [],
    chatConversationsLoaded: false,
    chatProxyOnline: false,
    // Chat opens wide (standard preset) with the conversation list showing;
    // the in-view toggle collapses it to the thin panel.
    chatPanelExpanded: true,
    chatMessages: [],
    chatStreamingMessage: null,
    chatSending: false,
    chatSendingConversationId: null,
    chatSendingConversationIds: [],
    chatError: null,
    chatFundsNotice: null,
    chatModels: [],
    chatModelsLoaded: false,
    chatModelsLoading: false,
    chatModelsError: null,
    chatSelectedModelId: '',
    chatImageModelId: null,
    chatInputDisabled: false,
    chatSendDisabled: false,
    chatAbortVisible: false,

    // Browser preview
    browserPreviewUrl: null,
    browserPreviewRequestId: 0,
    chatWorkspacePath: '',
    chatWorkspaceDefaultPath: '',

    // Streaming indicator
    chatThinkingElapsedMs: 0,
    chatWaitingForStream: false,
    chatThinkingPhase: null,

    // Router / dashboard port
    connectRouterValue: 'local',
    dashboardPortValue: '3117',

    // First-run setup
    appSetupStatusKnown: false,
    appSetupNeeded: false,
    appSetupComplete: false,
    appSetupStep: '',
  };
}

export function appendLogEntry(state: RendererUiState, entry: LogEvent): void {
  state.logs = [...state.logs.slice(-(MAX_LOGS - 1)), entry];
}

export function replaceLogEntries(state: RendererUiState, entries: LogEvent[]): void {
  state.logs = entries.slice(-MAX_LOGS);
}
