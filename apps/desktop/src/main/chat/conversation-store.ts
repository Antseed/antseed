/**
 * On-disk conversation store, backed by the pi-coding-agent session files.
 *
 * Conversations are not persisted separately — a conversation *is* a pi
 * session, and the UI shape is projected out of it on read.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AssistantMessage, Message, UserMessage } from '@mariozechner/pi-ai';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import { CHAT_DATA_DIR, getCurrentChatWorkspaceDir } from './workspace.js';
import {
  ANTSEED_PEER_CUSTOM_TYPE,
  resolveLatestPeerBinding,
  type ChatRouteMode,
} from './peer-selection.js';
import { sanitizeProviderHint } from './provider-hint.js';
import { normalizeServiceId, normalizeTokenCount } from './normalize.js';
import {
  convertPiMessagesToUi,
  deriveCost,
  deriveTitle,
  deriveUsage,
} from './message-projection.js';
import type { AiConversation, AiConversationSummary } from './conversation-types.js';

export const CHAT_SESSIONS_DIR = path.join(CHAT_DATA_DIR, 'sessions');
export const CHAT_AGENT_DIR = path.join(CHAT_DATA_DIR, 'pi-agent');

type SessionFileStat = {
  path: string;
  mtimeMs: number;
  size: number;
};

/** `summary: null` records a file that failed to parse, so a corrupted
    session is skipped without re-reading it on every list. */
type CachedSummary = {
  mtimeMs: number;
  size: number;
  summary: AiConversationSummary | null;
};

export type AntseedPeerData = { peerId: string; peerLabel?: string; routeMode?: ChatRouteMode };

export function isPersistedPeerBindingPinned(peerData: AntseedPeerData | null): peerData is AntseedPeerData {
  return Boolean(peerData?.peerId) && peerData?.routeMode === 'pinned';
}

export function projectPeerBinding(peerData: AntseedPeerData | null): Pick<
  AiConversation,
  'peerId' | 'peerLabel' | 'routeMode'
> {
  return {
    ...(peerData?.peerId ? { peerId: peerData.peerId } : {}),
    ...(peerData?.peerLabel ? { peerLabel: peerData.peerLabel } : {}),
    ...(peerData?.routeMode ? { routeMode: peerData.routeMode } : {}),
  };
}

export function projectPersistedConversationRoute<T extends {
  peerId?: string;
  routeMode?: ChatRouteMode;
}>(conversation: T): T {
  return conversation.peerId && conversation.routeMode === 'pinned'
    ? { ...conversation, routeMode: 'pinned' }
    : { ...conversation, peerId: undefined, routeMode: 'auto' };
}

export function extractPeerFromEntries(manager: SessionManager): AntseedPeerData | null {
  return resolveLatestPeerBinding(
    manager.getEntries() as Array<{ type?: string; customType?: string; data?: unknown }>,
  );
}

function latestResponsePeerId(messages: AiConversation['messages']): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const peerId = message.meta?.peerId?.trim();
    if (peerId) return peerId;
  }
  return undefined;
}

function summarizeConversation(conversation: AiConversation): AiConversationSummary {
  const totalTokens = normalizeTokenCount(conversation.usage.inputTokens)
    + normalizeTokenCount(conversation.usage.outputTokens);
  return {
    id: conversation.id,
    title: conversation.title,
    service: conversation.service,
    provider: conversation.provider,
    messageCount: conversation.messages.length,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    usage: conversation.usage,
    totalTokens,
    totalEstimatedCostUsd: deriveCost(conversation.messages),
    ...(conversation.peerId ? { peerId: conversation.peerId } : {}),
    ...(conversation.peerLabel ? { peerLabel: conversation.peerLabel } : {}),
    ...(conversation.routeMode ? { routeMode: conversation.routeMode } : {}),
    ...(conversation.lastResponsePeerId ? { lastResponsePeerId: conversation.lastResponsePeerId } : {}),
    ...(conversation.workspacePath ? { workspacePath: conversation.workspacePath } : {}),
  };
}

export class PiConversationStore {
  private readonly sessionsDir = CHAT_SESSIONS_DIR;
  private readonly ready: Promise<void>;
  private readonly pathCache = new Map<string, string>();
  private readonly pendingManagers = new Map<string, SessionManager>();
  private readonly summaryCache = new Map<string, CachedSummary>();
  private refreshInFlight: Promise<AiConversationSummary[]> | null = null;

  constructor() {
    this.ready = this.ensureDirs();
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(CHAT_AGENT_DIR, { recursive: true });
  }

  private async ensureWorkspaceDir(): Promise<string> {
    await this.ready;
    const workspaceDir = getCurrentChatWorkspaceDir();
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private async statSessionFiles(): Promise<SessionFileStat[]> {
    await this.ready;
    const names = await readdir(this.sessionsDir);
    const stats = await Promise.all(
      names
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => {
          const filePath = path.join(this.sessionsDir, name);
          try {
            const fileStat = await stat(filePath);
            return { path: filePath, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
          } catch {
            return null;
          }
        }),
    );
    return stats.filter((entry): entry is SessionFileStat => entry !== null);
  }

  /**
   * Summaries for every persisted session, re-parsing only files whose
   * mtime/size changed since the previous refresh. Session files are
   * append-only and 100+ accumulate over time, so a full re-parse per call
   * is what this cache exists to avoid.
   */
  private refreshSummaries(): Promise<AiConversationSummary[]> {
    this.refreshInFlight ??= this.refreshSummariesNow().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshSummariesNow(): Promise<AiConversationSummary[]> {
    const files = await this.statSessionFiles();

    const alivePaths = new Set(files.map((file) => file.path));
    for (const cachedPath of this.summaryCache.keys()) {
      if (!alivePaths.has(cachedPath)) {
        this.summaryCache.delete(cachedPath);
      }
    }

    this.pathCache.clear();
    const summaries: AiConversationSummary[] = [];
    for (const file of files) {
      const cached = this.summaryCache.get(file.path);
      let entry = cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size
        ? cached
        : null;
      if (!entry) {
        const conversation = await this.readConversationFromPath(file.path);
        entry = {
          mtimeMs: file.mtimeMs,
          size: file.size,
          summary: conversation ? summarizeConversation(conversation) : null,
        };
        this.summaryCache.set(file.path, entry);
      }
      if (!entry.summary) {
        continue;
      }
      this.pathCache.set(entry.summary.id, file.path);
      summaries.push(entry.summary);
    }
    return summaries;
  }

  private async buildConversationFromManager(manager: SessionManager): Promise<AiConversation> {
    const context = manager.buildSessionContext();
    const messages = convertPiMessagesToUi(context.messages as Message[]);
    const usage = deriveUsage(messages);
    const header = manager.getHeader();
    const createdAtRaw = header ? Date.parse(header.timestamp) : Date.now();
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : Date.now();
    const latestMessageAt = messages.reduce((max, message) => {
      const ts = normalizeTokenCount(message.createdAt);
      return ts > max ? ts : max;
    }, 0);

    let updatedAt = Math.max(createdAt, latestMessageAt);
    const sessionPath = manager.getSessionFile();
    if (sessionPath && existsSync(sessionPath)) {
      try {
        const fileStat = await stat(sessionPath);
        updatedAt = Math.max(updatedAt, Math.floor(fileStat.mtimeMs));
      } catch {
        // Keep the computed updatedAt when stat fails.
      }
    } else {
      updatedAt = Math.max(updatedAt, Date.now());
    }

    const peerData = extractPeerFromEntries(manager);
    const lastResponsePeerId = latestResponsePeerId(messages)
      ?? (peerData?.routeMode === 'auto' ? peerData.peerId : undefined);
    // SessionManager reads the cwd persisted in the session file; restoration
    // across app restarts depends on that value reflecting the session workspace.
    const sessionCwd = manager.getCwd() || undefined;
    return {
      id: manager.getSessionId(),
      title: manager.getSessionName() || deriveTitle(messages),
      service: normalizeServiceId(context.model?.modelId),
      provider: sanitizeProviderHint(context.model?.provider) ?? undefined,
      messages,
      createdAt,
      updatedAt,
      usage,
      ...projectPeerBinding(peerData),
      ...(lastResponsePeerId ? { lastResponsePeerId } : {}),
      ...(sessionCwd ? { workspacePath: sessionCwd } : {}),
    };
  }

  private async resolvePath(id: string): Promise<string | null> {
    await this.ready;
    const cached = this.pathCache.get(id);
    if (cached && existsSync(cached)) {
      return cached;
    }
    await this.refreshSummaries();
    return this.pathCache.get(id) ?? null;
  }

  private async readConversationFromPath(sessionPath: string): Promise<AiConversation | null> {
    try {
      const manager = SessionManager.open(sessionPath, this.sessionsDir);
      return await this.buildConversationFromManager(manager);
    } catch {
      return null;
    }
  }

  async list(): Promise<AiConversationSummary[]> {
    const summaryById = new Map<string, AiConversationSummary>();
    for (const summary of await this.refreshSummaries()) {
      summaryById.set(summary.id, summary);
    }

    for (const [conversationId, manager] of this.pendingManagers.entries()) {
      if (summaryById.has(conversationId)) {
        continue;
      }
      const conversation = await this.buildConversationFromManager(manager);
      summaryById.set(conversation.id, summarizeConversation(conversation));
    }

    return [...summaryById.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async get(id: string): Promise<AiConversation | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return await this.buildConversationFromManager(pending);
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return await this.readConversationFromPath(sessionPath);
  }

  async create(
    service?: string,
    provider?: string,
    peerId?: string,
    peerLabel?: string,
    routeMode?: ChatRouteMode,
  ): Promise<AiConversation> {
    const workspaceDir = await this.ensureWorkspaceDir();
    const manager = SessionManager.create(workspaceDir, this.sessionsDir);
    // Persist '' (not the local proxy sentinel) when no real upstream
    // provider is known. The sentinel used to leak through to the
    // `x-antseed-provider` header on send and trip the buyer proxy's
    // pinned-peer provider check, returning a confusing 502.
    const providerId = sanitizeProviderHint(provider) ?? '';
    manager.appendModelChange(providerId, normalizeServiceId(service));
    const trimmedPeerId = peerId?.trim() ?? '';
    if (trimmedPeerId) {
      manager.appendCustomEntry(ANTSEED_PEER_CUSTOM_TYPE, {
        peerId: trimmedPeerId,
        ...(peerLabel ? { peerLabel } : {}),
        ...(routeMode ? { routeMode } : {}),
      } satisfies AntseedPeerData);
    }
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) {
      throw new Error('Failed to create persisted pi session');
    }
    const conversation = await this.buildConversationFromManager(manager);
    this.pendingManagers.set(conversation.id, manager);
    this.pathCache.set(conversation.id, sessionPath);
    return conversation;
  }

  async appendImageGeneration(
    id: string,
    prompt: string,
    assistantContent: string,
    service: string,
    peerId?: string | null,
  ): Promise<{ user: UserMessage; assistant: AssistantMessage }> {
    const manager = await this.openSessionManager(id);
    if (!manager) throw new Error('Conversation not found');
    const timestamp = Date.now();
    const user: UserMessage = { role: 'user', content: prompt, timestamp };
    const trimmedPeerId = peerId?.trim() ?? '';
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: assistantContent }],
      api: 'openai-completions',
      provider: 'antseed',
      model: service,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: timestamp + 1,
      ...(trimmedPeerId ? { meta: { peerId: trimmedPeerId } } : {}),
    };
    manager.appendMessage(user);
    manager.appendMessage(assistant);
    this.markPersistedIfAvailable(id);
    return { user, assistant };
  }

  async setPeer(id: string, peerId: string, peerLabel?: string, routeMode?: ChatRouteMode): Promise<void> {
    const manager = await this.openSessionManager(id);
    if (!manager) return;
    const effectiveMode = routeMode ?? extractPeerFromEntries(manager)?.routeMode;
    manager.appendCustomEntry(
      ANTSEED_PEER_CUSTOM_TYPE,
      { peerId, peerLabel, ...(effectiveMode ? { routeMode: effectiveMode } : {}) } satisfies AntseedPeerData,
    );
  }

  /** Persist an in-conversation model switch. Without this the rebinding only
      lives in renderer memory and the next conversation-list refresh reverts
      the thread to the model it was created with. */
  async setModel(id: string, provider: string | undefined, service: string | undefined): Promise<void> {
    const manager = await this.openSessionManager(id);
    if (!manager) return;
    manager.appendModelChange(sanitizeProviderHint(provider) ?? '', normalizeServiceId(service));
  }

  async clearPeer(id: string): Promise<void> {
    const manager = await this.openSessionManager(id);
    if (!manager) return;
    manager.appendCustomEntry(ANTSEED_PEER_CUSTOM_TYPE, {});
  }

  async delete(id: string): Promise<void> {
    const pending = this.pendingManagers.get(id);
    const pendingPath = pending?.getSessionFile() ?? null;
    this.pendingManagers.delete(id);

    const sessionPath = (await this.resolvePath(id)) ?? pendingPath;
    if (!sessionPath) {
      this.pathCache.delete(id);
      return;
    }
    try {
      await unlink(sessionPath);
    } catch {
      // Session may already be deleted.
    }
    this.summaryCache.delete(sessionPath);
    this.pathCache.delete(id);
  }

  async openSessionManager(id: string): Promise<SessionManager | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return pending;
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return SessionManager.open(sessionPath, this.sessionsDir);
  }

  markPersistedIfAvailable(id: string): void {
    const pending = this.pendingManagers.get(id);
    if (!pending) {
      return;
    }
    const sessionPath = pending.getSessionFile();
    if (!sessionPath) {
      return;
    }
    if (!existsSync(sessionPath)) {
      return;
    }
    this.pendingManagers.delete(id);
    this.pathCache.set(id, sessionPath);
  }
}
