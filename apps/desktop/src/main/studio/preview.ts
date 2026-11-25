/**
 * Studio is a preview: off until the user turns it on in Settings. While off,
 * Studio's IPC refuses and chats run without the Studio skill. The choice is
 * kept in userData, so each profile has its own.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STUDIO_PREVIEW_OFF = 'Studio is off. Turn it on in Settings.';

let file: string | null = null;
let enabled: boolean | null = null;

export function initStudioPreview(at: string): void {
  file = at;
  enabled = null;
}

export function studioPreviewEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = file !== null && (JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown }).enabled === true;
    } catch {
      enabled = false;
    }
  }
  return enabled;
}

export function setStudioPreviewEnabled(next: boolean): boolean {
  if (!file) throw new Error('The Studio setting is not ready yet.');
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ enabled: next })}\n`);
  renameSync(tmp, file);
  enabled = next;
  return next;
}
