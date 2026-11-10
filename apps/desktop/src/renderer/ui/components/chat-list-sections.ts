/**
 * Sidebar chat sections: Pinned, one per project folder (the workspace a chat
 * works in, like Codex), the remaining chats, and Archived.
 */

export type ChatRecord = Record<string, unknown>;

export type ChatSection = {
  kind: 'pinned' | 'project' | 'chats' | 'archived';
  /** Stable key; a project's is its folder path. */
  key: string;
  label: string;
  /** Full folder path, for projects. */
  path?: string;
  conversations: ChatRecord[];
};

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function updatedAt(conv: ChatRecord): number {
  return num(conv.updatedAt) || num(conv.createdAt);
}

function idOf(conv: ChatRecord): string {
  return String(conv.id ?? '');
}

/** Trailing separators off, so `/a/b/` and `/a/b` are one project. */
export function normalizeFolder(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  const trimmed = text.replace(/[\\/]+$/, '');
  return trimmed || text;
}

export function folderName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

/** Chats touched in the last day first, then by activity, newest first. */
export function compareByActivity(left: ChatRecord, right: ChatRecord, now: number): number {
  const leftRecent = now - updatedAt(left) <= RECENT_WINDOW_MS ? 1 : 0;
  const rightRecent = now - updatedAt(right) <= RECENT_WINDOW_MS ? 1 : 0;
  if (leftRecent !== rightRecent) return rightRecent - leftRecent;
  const delta = updatedAt(right) - updatedAt(left);
  if (delta !== 0) return delta;
  const created = num(right.createdAt) - num(left.createdAt);
  if (created !== 0) return created;
  return idOf(left).localeCompare(idOf(right));
}

/** The folder a chat belongs under, or '' for the app's default workspace. */
export function projectFolder(conv: ChatRecord, defaultWorkspace: string): string {
  const folder = normalizeFolder(conv.workspacePath);
  if (!folder) return '';
  return folder === normalizeFolder(defaultWorkspace) ? '' : folder;
}

export function buildChatSections(
  conversations: readonly ChatRecord[],
  options: { defaultWorkspace: string; now: number },
): ChatSection[] {
  const pinned: ChatRecord[] = [];
  const archived: ChatRecord[] = [];
  const loose: ChatRecord[] = [];
  const projects = new Map<string, ChatRecord[]>();

  for (const conv of conversations) {
    if (num(conv.archivedAt)) { archived.push(conv); continue; }
    if (num(conv.pinnedAt)) { pinned.push(conv); continue; }
    const folder = projectFolder(conv, options.defaultWorkspace);
    if (!folder) { loose.push(conv); continue; }
    const list = projects.get(folder) ?? [];
    list.push(conv);
    projects.set(folder, list);
  }

  const byActivity = (a: ChatRecord, b: ChatRecord) => compareByActivity(a, b, options.now);
  const sections: ChatSection[] = [];

  if (pinned.length > 0) {
    // Most recently pinned on top.
    pinned.sort((a, b) => num(b.pinnedAt) - num(a.pinnedAt) || byActivity(a, b));
    sections.push({ kind: 'pinned', key: 'pinned', label: 'Pinned', conversations: pinned });
  }

  // Two folders with one name read as "name · parent".
  const nameCounts = new Map<string, number>();
  for (const folder of projects.keys()) {
    const name = folderName(folder);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const projectSections = [...projects.entries()].map(([folder, list]): ChatSection => {
    list.sort(byActivity);
    const name = folderName(folder);
    const parent = folderName(folder.slice(0, Math.max(0, folder.length - name.length)).replace(/[\\/]+$/, ''));
    const label = (nameCounts.get(name) ?? 0) > 1 && parent ? `${name} · ${parent}` : name;
    return { kind: 'project', key: folder, label, path: folder, conversations: list };
  });
  projectSections.sort((a, b) => byActivity(a.conversations[0]!, b.conversations[0]!));
  sections.push(...projectSections);

  if (loose.length > 0) {
    loose.sort(byActivity);
    sections.push({ kind: 'chats', key: 'chats', label: 'Chats', conversations: loose });
  }

  if (archived.length > 0) {
    archived.sort((a, b) => num(b.archivedAt) - num(a.archivedAt) || byActivity(a, b));
    sections.push({ kind: 'archived', key: 'archived', label: 'Archived', conversations: archived });
  }

  return sections;
}
