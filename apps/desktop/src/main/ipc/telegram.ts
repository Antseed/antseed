/**
 * IPC surface for the Telegram bridge.
 */
import { ipcMain } from 'electron';
import {
  type TelegramBridge,
} from '../telegram/bridge.js';

export function registerTelegramIpc(deps: { telegramBridge: TelegramBridge }): void {
  const { telegramBridge } = deps;

  ipcMain.handle('telegram:get-status', async () => {
    return { ok: true, data: telegramBridge.getStatus() };
  });

  ipcMain.handle('telegram:connect', async (_event, botToken: unknown) => {
    if (typeof botToken !== 'string' || botToken.trim().length === 0) {
      return { ok: false, error: 'Bot token is required' };
    }
    const result = await telegramBridge.connect(botToken);
    return { ok: result.ok, data: result.status, error: result.error };
  });

  ipcMain.handle('telegram:disconnect', async () => {
    await telegramBridge.disconnect();
    return { ok: true, data: telegramBridge.getStatus() };
  });
}
