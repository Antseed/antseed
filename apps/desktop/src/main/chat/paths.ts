import { homedir } from 'node:os';
import path from 'node:path';
import { isAttachOnly, resolveBuyerStateDir } from '../runtime/attach-only.js';

// Attach-only (testbench) desktops keep chats, sessions and projects next to the
// testbench buyer state so they never read or write the user's real ~/.antseed.
export const ANTSEED_HOME_DIR = isAttachOnly()
  ? path.join(resolveBuyerStateDir(), 'desktop')
  : path.join(homedir(), '.antseed');
export const CHAT_DATA_DIR = path.join(ANTSEED_HOME_DIR, 'chat');
export const CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'projects');
