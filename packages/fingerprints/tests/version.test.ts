import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FINGERPRINTS_PACKAGE_VERSION } from '../src/types.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('FINGERPRINTS_PACKAGE_VERSION', () => {
  it('equals the version in package.json', () => {
    expect(FINGERPRINTS_PACKAGE_VERSION).toBe(packageJson.version);
  });
});
