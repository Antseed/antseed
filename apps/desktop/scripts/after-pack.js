// Re-sign the app bundle with ad-hoc signature after electron-builder packs it.
// Only runs when no real Developer ID identity is configured — electron-builder
// handles signing itself when identity is set, making ad-hoc signing unnecessary.

import { execFileSync } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import path from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    await chmod(path.join(context.appOutDir, 'chrome-sandbox'), 0o4755);
    return;
  }
  if (context.electronPlatformName !== 'darwin') return;

  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (identity && identity !== null) {
    console.log('[after-pack] Real identity configured, skipping ad-hoc signing.');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[after-pack] Ad-hoc signing: ${appPath}`);

  execFileSync('codesign', [
    '--deep',
    '--force',
    '--sign',
    '-',
    appPath,
  ], { stdio: 'inherit' });

  console.log('[after-pack] Ad-hoc signing complete');
}
