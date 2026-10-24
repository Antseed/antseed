import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/utils/file-lock.js';

describe('withFileLock', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-lock-'));
    file = join(dir, 'config.json');
    await writeFile(file, '[]');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const append = (value: number) => async () => {
    const items = JSON.parse(await readFile(file, 'utf-8')) as number[];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(file, JSON.stringify([...items, value]));
  };

  it('runs concurrent edits one at a time so none is lost', async () => {
    await Promise.all([1, 2, 3, 4].map((value) => withFileLock(file, append(value))));
    expect((JSON.parse(await readFile(file, 'utf-8')) as number[]).sort()).toEqual([1, 2, 3, 4]);
    await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for a lock held by another process', async () => {
    await writeFile(`${file}.lock`, '999\n');
    const edit = withFileLock(file, append(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([]);
    await rm(`${file}.lock`);
    await edit;
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([1]);
  });

  it('takes over a lock left behind by a crashed process', async () => {
    await writeFile(`${file}.lock`, '999\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    await withFileLock(file, append(1));
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([1]);
  });

  it('gives up when the lock is never released', async () => {
    await writeFile(`${file}.lock`, '999\n');
    await expect(withFileLock(file, append(1), { timeoutMs: 50 })).rejects.toThrow(/Timed out waiting/);
  });

  it('releases the lock when the edit fails', async () => {
    await expect(withFileLock(file, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await withFileLock(file, append(1));
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([1]);
  });

  it('never deletes a lock that is released and retaken while it waits', async () => {
    await writeFile(`${file}.lock`, 'other\n');
    const edit = withFileLock(file, append(1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The holder releases and another process takes the lock straight away.
    await rm(`${file}.lock`);
    await writeFile(`${file}.lock`, 'successor\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await readFile(`${file}.lock`, 'utf-8')).toBe('successor\n');
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([]);
    await rm(`${file}.lock`);
    await edit;
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([1]);
  });
});
