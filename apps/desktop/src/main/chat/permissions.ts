import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHAT_DATA_DIR } from './paths.js';

const CHAT_SETTINGS_FILE = path.join(CHAT_DATA_DIR, 'settings.json');

export type ChatPermissionMode = 'manual' | 'full';
export type ToolApprovalDecision = 'allow_once' | 'always_allow' | 'deny';

export type ToolApprovalRequest = {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  permissionKey: string;
  permissionLabel: string;
  input: Record<string, unknown>;
  workspacePath: string;
  /** Model the approval is scoped to: "always allow" is remembered per model. */
  modelId: string | null;
  modelName: string | null;
  title: string;
  description: string;
  subject: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

export type ChatPeerSettings = {
  permissionMode: ChatPermissionMode;
  toolPermissions: string[];
};

export type ChatGlobalSettings = {
  workspacePath: string | null;
  /**
   * Agent-access settings per scope. Scopes are gateway model ids now; the
   * key keeps its old name (and old per-peer rows stay inert) so existing
   * settings files load unchanged.
   */
  peers: Record<string, ChatPeerSettings>;
};

const DEFAULT_CHAT_GLOBAL_SETTINGS: ChatGlobalSettings = {
  workspacePath: null,
  peers: {},
};

let chatSettingsCache: ChatGlobalSettings | null = null;

export function normalizePermissionMode(value: unknown): ChatPermissionMode {
  return value === 'full' ? 'full' : 'manual';
}

function normalizePeerId(peerId: string | null | undefined): string | null {
  const trimmed = peerId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeToolPermissions(value: unknown): string[] {
  const permissions = Array.isArray(value)
    ? value.filter((permission): permission is string => typeof permission === 'string')
    : [];
  return Array.from(new Set(permissions.map((permission) => permission.trim()).filter(Boolean))).sort();
}

function normalizePeerSettings(value: unknown): ChatPeerSettings {
  if (!value || typeof value !== 'object') {
    return { permissionMode: 'manual', toolPermissions: [] };
  }
  return {
    permissionMode: normalizePermissionMode((value as { permissionMode?: unknown }).permissionMode),
    toolPermissions: normalizeToolPermissions((value as { toolPermissions?: unknown }).toolPermissions),
  };
}

function normalizePeers(value: unknown): Record<string, ChatPeerSettings> {
  const peers: Record<string, ChatPeerSettings> = {};
  if (!value || typeof value !== 'object') return peers;

  for (const [peerId, settings] of Object.entries(value as Record<string, unknown>)) {
    const normalizedPeerId = normalizePeerId(peerId);
    if (!normalizedPeerId) continue;
    peers[normalizedPeerId] = normalizePeerSettings(settings);
  }

  return peers;
}

function normalizeChatSettings(value: unknown): ChatGlobalSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_CHAT_GLOBAL_SETTINGS };
  }
  const workspacePath = (value as { workspacePath?: unknown }).workspacePath;

  return {
    workspacePath: typeof workspacePath === 'string' && workspacePath.trim()
      ? workspacePath.trim()
      : null,
    peers: normalizePeers((value as { peers?: unknown }).peers),
  };
}

async function loadChatSettings(): Promise<ChatGlobalSettings> {
  if (chatSettingsCache) return chatSettingsCache;

  try {
    const raw = await readFile(CHAT_SETTINGS_FILE, 'utf8');
    chatSettingsCache = normalizeChatSettings(JSON.parse(raw));
    return chatSettingsCache;
  } catch {
    chatSettingsCache = { ...DEFAULT_CHAT_GLOBAL_SETTINGS };
    return chatSettingsCache;
  }
}

async function saveChatSettings(next: ChatGlobalSettings): Promise<void> {
  chatSettingsCache = normalizeChatSettings(next);
  await mkdir(CHAT_DATA_DIR, { recursive: true });
  await writeFile(CHAT_SETTINGS_FILE, JSON.stringify(chatSettingsCache, null, 2), 'utf8');
}

export async function getModelPermissionMode(peerId: string | null | undefined): Promise<ChatPermissionMode> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) return 'manual';
  const settings = await loadChatSettings();
  return settings.peers[normalizedPeerId]?.permissionMode ?? 'manual';
}

export async function getChatWorkspacePath(): Promise<string | null> {
  const settings = await loadChatSettings();
  return settings.workspacePath;
}

export async function setChatWorkspacePath(workspacePath: string): Promise<void> {
  const trimmed = workspacePath.trim();
  if (!trimmed) {
    throw new Error('Workspace path is required');
  }
  const settings = await loadChatSettings();
  await saveChatSettings({
    ...settings,
    workspacePath: trimmed,
  });
}

export async function setModelPermissionMode(peerId: string | null | undefined, mode: ChatPermissionMode): Promise<void> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) {
    throw new Error('Cannot persist permission mode without a model id');
  }
  const settings = await loadChatSettings();
  const peerSettings = settings.peers[normalizedPeerId] ?? { permissionMode: 'manual', toolPermissions: [] };
  await saveChatSettings({
    ...settings,
    peers: {
      ...settings.peers,
      [normalizedPeerId]: {
        ...peerSettings,
        permissionMode: normalizePermissionMode(mode),
      },
    },
  });
}

export async function isToolAllowedForModel(peerId: string | null | undefined, permissionKey: string): Promise<boolean> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) return false;
  const settings = await loadChatSettings();
  return settings.peers[normalizedPeerId]?.toolPermissions.includes(permissionKey) ?? false;
}

export async function allowToolForModel(peerId: string | null | undefined, permissionKey: string): Promise<void> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) {
    throw new Error('Cannot persist tool approval without a model id');
  }
  const settings = await loadChatSettings();
  const peerSettings = settings.peers[normalizedPeerId] ?? { permissionMode: 'manual', toolPermissions: [] };
  await saveChatSettings({
    ...settings,
    peers: {
      ...settings.peers,
      [normalizedPeerId]: {
        ...peerSettings,
        toolPermissions: normalizeToolPermissions([...peerSettings.toolPermissions, permissionKey]),
      },
    },
  });
}
