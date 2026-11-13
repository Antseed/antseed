import { SAFE_STORAGE_EXPORT_ENV } from './safe-storage-export-protocol.js';

/**
 * This process is the safeStorage export helper (app-rename.ts): it runs
 * under the app's previous name, decrypts what it is given and exits. It
 * opens no window and starts no gateway.
 */
export const IS_SAFE_STORAGE_EXPORT = process.env[SAFE_STORAGE_EXPORT_ENV] === '1';
