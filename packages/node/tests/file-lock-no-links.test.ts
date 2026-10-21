import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A drive without hard links (some FAT or network drives).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(async () => { throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }); }),
  };
});

const { FileLockUnsupportedError, withFileLock } = await import('../src/utils/file-lock.js');

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('file lock without hard links', () => {
  it('refuses to lock rather than creating the lock before its owner record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ants-lock-'));
    dirs.push(dir);
    const task = vi.fn(async () => 'entered');
    await expect(withFileLock(join(dir, 'test.lock'), task)).rejects.toBeInstanceOf(FileLockUnsupportedError);
    expect(task).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]); // neither a lock nor its staged copy is left
  });
});
