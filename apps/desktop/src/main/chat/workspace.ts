import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ANTSEED_HOME_DIR, CHAT_DATA_DIR, CHAT_WORKSPACE_DIR } from './paths.js';
import { getChatWorkspacePath, setChatWorkspacePath } from './permissions.js';

export { ANTSEED_HOME_DIR, CHAT_DATA_DIR, CHAT_WORKSPACE_DIR };
const LEGACY_CHAT_WORKSPACE_STATE_FILE = path.join(CHAT_DATA_DIR, 'workspace.json');
const WORKSPACE_PICKER_TOOLING_DIRS = new Set([
  '.claude',
  '.codex',
  '.git',
  '.github',
  '.vscode',
  '.agents',
]);

let currentChatWorkspaceDir = CHAT_WORKSPACE_DIR;

function resolveExistingDirectory(startPath: string): string | null {
  let current = path.resolve(startPath);
  for (;;) {
    if (existsSync(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getCurrentChatWorkspaceDir(): string {
  return currentChatWorkspaceDir;
}

async function loadLegacyChatWorkspacePath(): Promise<string | null> {
  try {
    const raw = await readFile(LEGACY_CHAT_WORKSPACE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { path?: unknown };
    const savedPath = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    return savedPath || null;
  } catch {
    return null;
  }
}

export async function loadChatWorkspaceDir(): Promise<string> {
  try {
    const savedPath = await getChatWorkspacePath() ?? await loadLegacyChatWorkspacePath();
    if (savedPath && existsSync(savedPath)) {
      currentChatWorkspaceDir = savedPath;
      await setChatWorkspacePath(savedPath);
    }
  } catch {
    // Keep default workspace dir.
  }
  return currentChatWorkspaceDir;
}

export async function getWorkspacePickerDefaultDir(): Promise<string> {
  const workspaceDir = await loadChatWorkspaceDir();
  const existingWorkspaceDir = resolveExistingDirectory(workspaceDir)
    ?? resolveExistingDirectory(CHAT_WORKSPACE_DIR)
    ?? homedir();
  const baseName = path.basename(existingWorkspaceDir).toLowerCase();

  if (WORKSPACE_PICKER_TOOLING_DIRS.has(baseName)) {
    const parentDir = path.dirname(existingWorkspaceDir);
    return parentDir;
  }

  return existingWorkspaceDir;
}

export async function persistChatWorkspaceDir(workspaceDir: string): Promise<string> {
  const trimmed = workspaceDir.trim();
  if (!trimmed) {
    throw new Error('Workspace path is required');
  }
  if (!existsSync(trimmed)) {
    throw new Error(`Workspace does not exist: ${trimmed}`);
  }
  await setChatWorkspacePath(trimmed);
  currentChatWorkspaceDir = trimmed;
  return currentChatWorkspaceDir;
}

