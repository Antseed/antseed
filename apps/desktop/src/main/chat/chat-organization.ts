/**
 * Pinned and archived chats. A conversation is a pi session file, so these
 * flags live beside the sessions in one small JSON file keyed by session id.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ChatOrganization = {
  version: 1;
  /** Session id → when it was pinned (ms). */
  pinned: Record<string, number>;
  /** Session id → when it was archived (ms). */
  archived: Record<string, number>;
};

export type ConversationFlags = { pinned?: boolean; archived?: boolean };

export type ChatFlagFields = { pinnedAt?: number; archivedAt?: number };

export function emptyOrganization(): ChatOrganization {
  return { version: 1, pinned: {}, archived: {} };
}

function readTimes(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, at] of Object.entries(value)) {
    if (id && typeof at === 'number' && Number.isFinite(at) && at > 0) out[id] = at;
  }
  return out;
}

export function parseOrganization(raw: string): ChatOrganization {
  try {
    const parsed = JSON.parse(raw) as { pinned?: unknown; archived?: unknown };
    return { version: 1, pinned: readTimes(parsed.pinned), archived: readTimes(parsed.archived) };
  } catch {
    return emptyOrganization();
  }
}

/** Pinning brings a chat out of the archive; archiving unpins it. */
export function applyFlags(
  current: ChatOrganization,
  id: string,
  flags: ConversationFlags,
  now: number = Date.now(),
): ChatOrganization {
  const pinned = { ...current.pinned };
  const archived = { ...current.archived };
  if (flags.pinned === true) {
    pinned[id] = pinned[id] ?? now;
    delete archived[id];
  } else if (flags.pinned === false) {
    delete pinned[id];
  }
  if (flags.archived === true) {
    archived[id] = archived[id] ?? now;
    delete pinned[id];
  } else if (flags.archived === false) {
    delete archived[id];
  }
  return { version: 1, pinned, archived };
}

export function forgetConversation(current: ChatOrganization, id: string): ChatOrganization {
  if (!(id in current.pinned) && !(id in current.archived)) return current;
  const pinned = { ...current.pinned };
  const archived = { ...current.archived };
  delete pinned[id];
  delete archived[id];
  return { version: 1, pinned, archived };
}

export function flagsFor(organization: ChatOrganization, id: string): ChatFlagFields {
  const pinnedAt = organization.pinned[id];
  const archivedAt = organization.archived[id];
  return {
    ...(pinnedAt ? { pinnedAt } : {}),
    ...(archivedAt ? { archivedAt } : {}),
  };
}

/** Reads once, then serves from memory. Each change is a queued read-modify-write through a temp file, so concurrent pins can't lose one another. */
export class ChatOrganizationStore {
  private cached: ChatOrganization | null = null;
  private loading: Promise<ChatOrganization> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  read(): Promise<ChatOrganization> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= readFile(this.filePath, 'utf8')
      .then(parseOrganization, () => emptyOrganization())
      .then((organization) => {
        this.cached ??= organization;
        return this.cached;
      });
    return this.loading;
  }

  setFlags(id: string, flags: ConversationFlags): Promise<ChatFlagFields> {
    return this.change(async (current) => {
      const next = applyFlags(current, id, flags);
      return { next, result: flagsFor(next, id) };
    });
  }

  forget(id: string): Promise<void> {
    return this.change(async (current) => ({ next: forgetConversation(current, id), result: undefined }));
  }

  private change<T>(update: (current: ChatOrganization) => Promise<{ next: ChatOrganization; result: T }>): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const { next, result } = await update(current);
      if (next !== current) await this.write(next);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(next: ChatOrganization): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
    this.cached = next;
  }
}
