/**
 * IPC surface for desktop shell actions: opening tools and external URLs,
 * window presets, directory pickers, and attachment downloads.
 */
import { ipcMain } from 'electron';
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
  connectableProfiles,
} from '../connected-apps/patching/profiles.js';
import {
  getMainWindow,
} from '../ui/window.js';
import {
  type OpenDialogOptions,
  dialog,
  shell,
} from 'electron';
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
      const profile = connectableProfiles().find((item) => item.name === key || item.toolName === key);
      if (!profile) {
        return { ok: false, error: 'Unknown tool.' };
      }
      // The profile's launch target (user-picked, or the default desktop app
      // for known tools) wins over the packaged open action.
      const launchTarget = effectiveLaunchTarget(profile.name);
      if (launchTarget) {
        const result = launchAppTarget(launchTarget);
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
          const result = launchAppTarget(target);
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
