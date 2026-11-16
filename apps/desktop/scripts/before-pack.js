// Runs prepare-dist for the arch electron-builder is about to pack, so each
// mac app bundle gets matching-arch native modules (better-sqlite3,
// node-datachannel, keytar prebuilds).
//
// This is what lets release-mac.mjs build x64 + arm64 in a SINGLE
// electron-builder invocation: electron-builder then generates one
// latest-mac.yml listing both arches' artifacts itself. The previous
// two-pass release uploaded a channel file per pass, and the second
// (arm64) upload clobbered the first — leaving Intel machines a feed with
// no x64 entries, whose first-file fallback handed them the arm64 zip.
//
// Windows/Linux builds run prepare-dist from their npm scripts on
// arch-matching runners, so the hook no-ops there.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// electron-builder passes context.arch as the app-builder-lib Arch enum.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };

export default async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const arch = ARCH_NAMES[context.arch];
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`[before-pack] Unsupported mac arch: ${context.arch}`);
  }

  console.log(`[before-pack] prepare-dist for ${arch}`);
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-dist.mjs')], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ANTSEED_PACK_ARCH: arch },
  });
}
