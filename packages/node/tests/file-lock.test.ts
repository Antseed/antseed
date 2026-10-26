import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/utils/file-lock.js';

const lockModule = fileURLToPath(new URL('../src/utils/file-lock.ts', import.meta.url));
const children: ChildProcess[] = [];

/** Runs `body` in a separate Node process with `withFileLock`, fs helpers and `file` in scope. */
function runInChild(body: string, file: string): ChildProcess {
  const script = `
    import { readFile, writeFile } from 'node:fs/promises';
    import { withFileLock } from ${JSON.stringify(lockModule)};
    const file = ${JSON.stringify(file)};
    ${body}
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(child);
  return child;
}

/** Starts another process that holds the lock until its stdin closes. */
async function holdInChild(file: string): Promise<ChildProcess> {
  const child = runInChild(`
    await withFileLock(file, async () => {
      process.stdout.write('locked\\n');
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once('end', resolve));
    });
    process.exit(0);
  `, file);
  await once(child.stdout!, 'data');
  return child;
}

describe('withFileLock', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-lock-'));
    file = join(dir, 'config.json');
    await writeFile(file, '[]');
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
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
  });

  it('waits for a lock held by another process', async () => {
    const holder = await holdInChild(file);
    const edit = withFileLock(file, append(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([]);
    holder.stdin!.end();
    await edit;
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([1]);
  });

  it('is released when its holder crashes', async () => {
    const holder = await holdInChild(file);
    const edit = withFileLock(file, append(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([]);
    holder.kill('SIGKILL');
    await edit;
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([1]);
  });

  it('never lets two processes edit at once', async () => {
    const children = [100, 200].map((base) => runInChild(`
      for (let i = 1; i <= 10; i++) await withFileLock(file, async () => {
        const items = JSON.parse(await readFile(file, 'utf-8'));
        await new Promise((resolve) => setTimeout(resolve, 2));
        await writeFile(file, JSON.stringify([...items, ${base} + i]));
      });
      process.exit(0);
    `, file));
    // Listen for exits before awaiting anything, so a fast child can't exit unobserved.
    const exits = children.map((child) => once(child, 'exit'));
    await Promise.all([1, 2, 3, 4, 5].map((value) => withFileLock(file, append(value))));
    expect((await Promise.all(exits)).map(([code]) => code)).toEqual([0, 0]);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toHaveLength(25);
  });

  it('gives up when the lock is never released', async () => {
    await holdInChild(file);
    await expect(withFileLock(file, append(1), { timeoutMs: 50 })).rejects.toThrow(/Timed out waiting/);
  });

  it('releases the lock when the edit fails', async () => {
    await expect(withFileLock(file, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await withFileLock(file, append(1));
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([1]);
  });
});
