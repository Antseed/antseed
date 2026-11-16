import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Electron binary this workspace installed, or null when its download was skipped. */
function electronBinary() {
  try {
    const binary = createRequire(import.meta.url)('electron');
    return typeof binary === 'string' && existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

// The packaged desktop runs the buyer with Electron's executable (ELECTRON_RUN_AS_NODE), whose
// BoringSSL lacks ciphers standalone Node has (chacha20-poly1305): a Node-only test cannot catch
// a Colony pool request that fails to encrypt there.
test('a buyer under the desktop runtime encrypts for a Colony pool worker and opens its answer', (t) => {
  const binary = process.env.ANTSEED_TEST_ELECTRON ?? electronBinary();
  if (!binary) {
    assert.ok(!process.env.CI, 'CI installs Electron: its binary is missing');
    return t.skip('Electron is not installed here');
  }
  const output = execFileSync(binary, [path.join(here, 'worker-e2e-roundtrip.mjs')], {
    cwd: path.join(here, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(output, /^ok electron=\d+\./);
});
