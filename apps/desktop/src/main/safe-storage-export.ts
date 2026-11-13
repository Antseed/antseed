/**
 * The safeStorage export helper: a short-lived copy of the app started under
 * its previous runtime name, so safeStorage uses that name's key (the macOS
 * keychain entry "<name> Safe Storage", the Linux secret store entry, or on
 * Windows the key in that userData's `Local State`). It decrypts the base64
 * blobs it gets on stdin and prints the plaintexts as one JSON line on stdout
 * for the app, which re-encrypts them under its new name.
 */
import { app, safeStorage } from 'electron';
import {
  SAFE_STORAGE_EXPORT_RESULT_PREFIX,
  type SafeStorageExportRequest,
  type SafeStorageExportResult,
} from './safe-storage-export-protocol.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Runs the helper. app-context.ts has already set the old name and userData
 * (synchronously, before app ready, which safeStorage needs), and main.ts
 * starts nothing else in this mode.
 */
export function runSafeStorageExport(): void {
  void Promise.all([readStdin(), app.whenReady()])
    .then(([input]) => {
      if (process.platform === 'darwin') app.dock?.hide();
      const request = JSON.parse(input) as Partial<SafeStorageExportRequest>;
      const available = safeStorage.isEncryptionAvailable();
      const result: SafeStorageExportResult = {
        available,
        plain: (Array.isArray(request.blobs) ? request.blobs : []).map((blob) => {
          if (!available || typeof blob !== 'string') return null;
          try {
            return safeStorage.decryptString(Buffer.from(blob, 'base64'));
          } catch {
            return null;
          }
        }),
      };
      process.stdout.write(`${SAFE_STORAGE_EXPORT_RESULT_PREFIX}${JSON.stringify(result)}\n`, () => app.exit(0));
    })
    .catch((err: unknown) => {
      process.stderr.write(`safeStorage export failed: ${err instanceof Error ? err.message : String(err)}\n`);
      app.exit(1);
    });
}
