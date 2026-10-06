/**
 * IPC surface for desktop shell actions: opening tools and external URLs,
 * window presets, directory pickers, and attachment downloads.
 */
import { ipcMain } from 'electron';
import {
  toolDesktopAppNames,
  toolResumeCommand,
} from '../../shared/tool-resume.js';
import {
  setDesktopDebugEnabled,
} from '../app-context.js';
import {
  resolveAttachmentPath,
} from '../chat/attachments/store.js';
import {
  getWorkspacePickerDefaultDir,
} from '../chat/workspace.js';
import {
  launchAppTarget,
  listInstalledAppsWithIcons,
} from '../connected-apps/installed.js';
import {
  captureManagedAppTarget,
  markAppTargetManaged,
  namedAppTarget,
  waitForAppTarget,
} from '../connected-apps/launcher.js';
import {
  effectiveLaunchTarget,
} from '../connected-apps/profile-targets.js';
import {
  allSystemProxyProfiles,
} from '../system-proxy/profiles.js';
import {
  systemProxyCaPath,
} from '../system-proxy/paths.js';
import {
  applyWindowPreset,
  applyWindowView,
  getMainWindow,
} from '../ui/window.js';
import {
  type OpenDialogOptions,
  dialog,
  shell,
} from 'electron';
import {
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  copyFile,
} from 'node:fs/promises';

export function registerDesktopIpc(): void {
  ipcMain.handle('desktop:set-debug-logs', (_event, enabled: boolean) => {
    setDesktopDebugEnabled(Boolean(enabled));
    return { ok: true };
  });

  ipcMain.handle('desktop:open-external-url', async (_event, rawUrl: string) => {
    try {
      const url = new URL(typeof rawUrl === 'string' ? rawUrl : '');
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, error: 'Only http(s) URLs can be opened.' };
      }
      await shell.openExternal(url.toString());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('desktop:open-tool', async (_event, toolName: string) => {
    try {
      const key = typeof toolName === 'string' ? toolName : '';
      if (key === 'cursor') {
        const target = namedAppTarget('Cursor');
        if (!target) return { ok: false, error: 'Could not find Cursor on this device.' };
        const result = launchAppTarget(target);
        if (result.ok) await waitForAppTarget(target);
        return result;
      }
      const profile = allSystemProxyProfiles().find((item) => item.name === key || item.toolName === key);
      if (!profile) {
        return { ok: false, error: 'Unknown tool.' };
      }
      // The profile's launch target (user-picked, or the default desktop app
      // for known tools) wins over the packaged open action.
      const launchTarget = effectiveLaunchTarget(profile.name);
      if (launchTarget) {
        const result = launchAppTarget(launchTarget, {
          env: { NODE_EXTRA_CA_CERTS: systemProxyCaPath() },
        });
        // Resolve only once the app is actually up — the caller's connect
        // spinner runs off this promise.
        if (result.ok) {
          markAppTargetManaged(launchTarget);
          await waitForAppTarget(launchTarget);
          await captureManagedAppTarget(launchTarget);
        }
        return result;
      }
      if (profile.openUrl) {
        await shell.openExternal(profile.openUrl);
        return { ok: true, fallback: profile.openUrl };
      }
      if (profile.restartAppName) {
        const target = namedAppTarget(profile.restartAppName);
        if (!target) {
          return { ok: false, error: `Could not find ${profile.restartAppName} on this device.` };
        }
        try {
          // A resolved path launches the same way everywhere; macOS name-only
          // targets still go through `open -a`.
          const result = launchAppTarget(target, {
            env: { NODE_EXTRA_CA_CERTS: systemProxyCaPath() },
          });
          if (!result.ok) return result;
          markAppTargetManaged(target);
          await waitForAppTarget(target);
          await captureManagedAppTarget(target);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return { ok: false, error: 'No open target configured for this tool.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Reopen a tool chat session — target 'terminal' runs the tool's resume
  // command (e.g. `codex resume <id>`), target 'app' launches the tool's
  // desktop app (app-level; none expose a per-session deep link). The command
  // string comes from the shared toolResumeCommand mapping only — session
  // keys are validated to shell-inert characters there.
  ipcMain.handle('desktop:open-tool-session', (_event, tool: unknown, sessionKey: unknown, target: unknown) => {
    const toolSlug = typeof tool === 'string' ? tool : '';
    if (target === 'app') {
      const appNames = toolDesktopAppNames(toolSlug);
      if (appNames.length === 0) {
        return { ok: false, error: 'This tool has no known desktop app.' };
      }
      if (process.platform !== 'darwin') {
        return { ok: false, error: `Open the ${appNames[0]} app manually on this platform.` };
      }
      for (const appName of appNames) {
        try {
          execFileSync('open', ['-a', appName], { stdio: 'pipe' });
          return { ok: true };
        } catch {
          // Try the next release-channel variant.
        }
      }
      return { ok: false, error: `The ${appNames[0]} app doesn't seem to be installed.` };
    }
    const command = toolResumeCommand(
      toolSlug,
      typeof sessionKey === 'string' ? sessionKey : '',
    );
    if (!command) {
      return { ok: false, error: 'This tool has no session-resume command.' };
    }
    try {
      if (process.platform === 'darwin') {
        execFileSync('osascript', [
          '-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`,
          '-e', 'tell application "Terminal" to activate',
        ], { stdio: 'pipe' });
        return { ok: true, command };
      }
      if (process.platform === 'win32') {
        const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', command], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return { ok: true, command };
      }
      return { ok: false, error: `Run it yourself: ${command}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('window:apply-view', (_event, viewName: string) => {
    return applyWindowView(typeof viewName === 'string' ? viewName : '');
  });

  ipcMain.handle('window:apply-preset', (_event, presetName: string) => {
    return applyWindowPreset(typeof presetName === 'string' ? presetName : '');
  });

  ipcMain.handle(
    'attachment:download',
    async (
      _event,
      conversationId: string,
      attachmentId: string,
      suggestedName: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      // Download flow via dialog.showSaveDialog + copyFile. More reliable
      // cross-platform than relying on <a download> with a custom
      // Electron protocol URL — Chromium's save-to-disk path is only
      // guaranteed for http(s)/data/blob.
      try {
        const resolved = await resolveAttachmentPath(conversationId, attachmentId);
        if (!resolved) {
          return { ok: false, error: 'Attachment not found' };
        }
        const win = getMainWindow();
        const safeSuggested = typeof suggestedName === 'string' && suggestedName.trim().length > 0
          ? suggestedName.trim()
          : 'attachment';
        const result = win
          ? await dialog.showSaveDialog(win, { defaultPath: safeSuggested })
          : await dialog.showSaveDialog({ defaultPath: safeSuggested });
        if (result.canceled || !result.filePath) {
          return { ok: false, error: 'cancelled' };
        }
        await copyFile(resolved, result.filePath);
        return { ok: true, path: result.filePath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('desktop:pick-directory', async () => {
    const currentWorkspaceDir = await getWorkspacePickerDefaultDir();
    const dialogOptions: OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Select Workspace Folder',
      buttonLabel: 'Use Folder',
      defaultPath: currentWorkspaceDir,
    };
    const win = getMainWindow();
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    return {
      ok: !result.canceled,
      path: result.canceled ? null : (result.filePaths[0] ?? null),
    };
  });

  ipcMain.handle('desktop:list-installed-apps', () => listInstalledAppsWithIcons());
}
