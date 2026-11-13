/**
 * The git branch a chat's workspace is on, read from `.git/HEAD` without
 * running git. Handles worktrees and submodules (`.git` is a file naming
 * the real git dir) and detached heads (short commit id).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_PARENT_STEPS = 40;
const CACHE_MS = 5_000;

export function parseHead(head: string): string | null {
  const text = head.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (ref) return ref[1]!.trim() || null;
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(text)) return text.slice(0, 7);
  return null;
}

async function gitDirFor(dotGit: string): Promise<string | null> {
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) return dotGit;
    if (!info.isFile()) return null;
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'));
    if (!pointer) return null;
    return path.resolve(path.dirname(dotGit), pointer[1]!.trim());
  } catch {
    return null;
  }
}

/** Walks up from `dir` to the nearest repository and reads its HEAD. */
export async function readGitBranch(dir: string): Promise<string | null> {
  if (!dir || !path.isAbsolute(dir)) return null;
  let current = path.resolve(dir);
  for (let step = 0; step < MAX_PARENT_STEPS; step += 1) {
    const gitDir = await gitDirFor(path.join(current, '.git'));
    if (gitDir) {
      try {
        return parseHead(await readFile(path.join(gitDir, 'HEAD'), 'utf8'));
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** One HEAD read per workspace every few seconds, however often the chat list refreshes. */
export class GitBranchCache {
  private readonly entries = new Map<string, { at: number; branch: Promise<string | null> }>();

  constructor(
    private readonly read: (dir: string) => Promise<string | null> = readGitBranch,
    private readonly ttlMs: number = CACHE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(dir: string): Promise<string | null> {
    const cached = this.entries.get(dir);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.branch;
    const branch = this.read(dir).catch(() => null);
    this.entries.set(dir, { at: this.now(), branch });
    return branch;
  }
}
