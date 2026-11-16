import { describe, it, expect } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const currentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(currentDir, '..', '..');
const cliDir = resolve(repoRoot, 'apps', 'cli');
const cliEntry = resolve(cliDir, 'dist', 'cli', 'index.js');

const baselineConfig = {
  identity: { displayName: 'e2e-test' },
  providers: [],
  seller: {
    reserveFloor: 10,
    maxConcurrentBuyers: 5,
    enabledProviders: ['anthropic'],
    pricing: {
      defaults: {
        inputUsdPerMillion: 10,
        outputUsdPerMillion: 10,
      },
    },
  },
  buyer: {
    maxPricing: {
      defaults: {
        inputUsdPerMillion: 100,
        outputUsdPerMillion: 100,
      },
    },
    minPeerReputation: 50,
    proxyPort: 8377,
  },
  payments: {
    preferredMethod: 'crypto',
  },
  network: {
    bootstrapNodes: [],
  },
};

async function ensureCliBuilt(): Promise<void> {
  try {
    await access(cliEntry, fsConstants.R_OK);
  } catch {
    try {
      await execFile('pnpm', ['run', 'build'], { cwd: cliDir });
    } catch {
      await execFile('npm', ['run', 'build'], { cwd: cliDir });
    }
  }
}

describe('CLI runtime overrides non-persistence', () => {
  it('runtime override flags do not modify on-disk config', async () => {
    await ensureCliBuilt();

    const tempDir = await mkdtemp(join(tmpdir(), 'antseed-cli-override-test-'));
    const configPath = join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify(baselineConfig, null, 2), 'utf-8');

    try {
      try {
        await execFile(process.execPath, [
          cliEntry,
          '--config', configPath,
          'connect',
          '--router', 'non-existent-router',
          '--max-input-usd-per-million', '999',
          '--max-output-usd-per-million', '1999',
          '--port', '9123',
        ], {
          cwd: repoRoot,
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      } catch {
        // Expected: connect exits non-zero because router plugin does not exist.
      }

      const after = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(after).toEqual(baselineConfig);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
