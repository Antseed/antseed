/**
 * Opens an agent the user just gave the Antseed skills to: its desktop app
 * when it has one (Codex opens ChatGPT), otherwise a terminal running its CLI.
 */
import { execFile } from 'node:child_process';
import type { AppLaunchTarget } from './connected-apps/launch-settings.js';
import type { OpenAgentResult } from '../shared/gateway-types.js';

export type { OpenAgentResult };

/** Fixed commands only: nothing from the renderer reaches the shell. */
const AGENT_COMMANDS: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  hermes: 'hermes',
  pi: 'pi',
  droid: 'droid',
};

export type OpenAgentDeps = {
  platform: NodeJS.Platform;
  launchTarget: (id: string) => Promise<AppLaunchTarget | null>;
  launchApp: (target: AppLaunchTarget) => Promise<{ ok: boolean; error?: string }>;
  runInTerminal: (command: string) => Promise<void>;
};

export function agentCommand(id: string): string | null {
  return Object.prototype.hasOwnProperty.call(AGENT_COMMANDS, id) ? AGENT_COMMANDS[id]! : null;
}

// Loaded on use: the launch helpers pull in Electron.
const defaultDeps: OpenAgentDeps = {
  platform: process.platform,
  launchTarget: async (id) => (await import('./connected-apps/profile-targets.js')).effectiveLaunchTarget(id),
  launchApp: async (target) => (await import('./connected-apps/installed.js')).launchAppTarget(target),
  runInTerminal: (command) => new Promise<void>((resolve, reject) => {
    const script = ['tell application "Terminal"', 'activate', `do script "${command}"`, 'end tell'];
    execFile('osascript', script.flatMap((line) => ['-e', line]), (err) => (err ? reject(err) : resolve()));
  }),
};

export async function openAgent(id: string, deps: Partial<OpenAgentDeps> = {}): Promise<OpenAgentResult> {
  const command = agentCommand(id);
  if (!command) return { ok: false, error: 'Unknown agent.' };
  const { platform, launchTarget, launchApp, runInTerminal } = { ...defaultDeps, ...deps };

  const target = await launchTarget(id);
  if (target) {
    const result = await launchApp(target);
    if (result.ok) return { ok: true, via: 'app' };
  }

  if (platform === 'darwin') {
    await runInTerminal(command);
    return { ok: true, via: 'terminal' };
  }

  return { ok: false, error: `Run \`${command}\` in a terminal to start it.` };
}
