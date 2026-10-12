import { ipcMain } from 'electron';
import { stakingSessions } from '../staking/portal.js';
import { getMainWindow } from '../ui/window.js';

export function registerStakingIpc(): void {
  for (const action of ['open', 'copyLink'] as const) {
    ipcMain.handle(`staking:${action}`, async (event, options?: { page?: unknown }) => {
      if (event.sender !== getMainWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: 'Staking can only be accessed from the VPR main window.' };
      }
      try {
        const page = options?.page ?? 'stake';
        if (page !== 'stake' && page !== 'rewards') return { ok: false, error: 'Unknown staking page.' };
        await stakingSessions[action](page);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }
}
