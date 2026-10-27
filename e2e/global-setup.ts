import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Builds the dist output the e2e tests load (@antseed/node's subpath exports,
 * which the CLI sources import, and the CLI binary some tests spawn) once,
 * before any test file starts.
 *
 * Test files used to rebuild these in their own beforeAll hooks. Test files run
 * in parallel forks, so one fork's tsc (or the CLI's prebuild, which deletes
 * dist/) rewrote files another fork was importing at that moment, and the
 * import failed with "does not provide an export named …" or "Unexpected end
 * of input". Building once, up front, leaves dist/ untouched while tests run.
 *
 * Set ANTSEED_E2E_SKIP_BUILD=1 when both are already built.
 */
export default async function setup(): Promise<void> {
  if (process.env.ANTSEED_E2E_SKIP_BUILD === '1') return;
  for (const pkg of ['@antseed/node', '@antseed/cli']) {
    try {
      await execFile('pnpm', ['--filter', pkg, 'run', 'build'], { cwd: repoRoot, env: process.env, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
      throw new Error(`e2e setup: building ${pkg} failed\n${stdout}\n${stderr}`, { cause: error });
    }
  }
}
