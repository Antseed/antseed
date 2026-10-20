import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLockTimeoutError, withFileLock } from '../src/utils/file-lock.js';

const LOCK_MODULE = pathToFileURL(fileURLToPath(new URL('../src/utils/file-lock.ts', import.meta.url))).href;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ants-lock-'));
  dirs.push(dir);
  return join(dir, 'nested', 'test.lock');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('file lock', () => {
  it('runs callers in this process one at a time and removes the lock afterwards', async () => {
    const lock = await lockPath();
    const order: string[] = [];
    const task = (name: string) => withFileLock(lock, async () => {
      order.push(`${name}:start`);
      await sleep(10);
      order.push(`${name}:end`);
      return name;
    });
    expect(await Promise.all([task('a'), task('b'), task('c')])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    await expect(readFile(lock, 'utf8')).rejects.toThrow();
  });

  it('releases the lock when the task throws', async () => {
    const lock = await lockPath();
    await expect(withFileLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withFileLock(lock, async () => 'next')).toBe('next');
  });

  it('waits for a live process holding the lock, and times out', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined); // creates the directory
    await writeFile(lock, JSON.stringify({ pid: process.ppid }));
    await expect(withFileLock(lock, async () => 'never', { timeoutMs: 80, retryMs: 10 })).rejects.toBeInstanceOf(FileLockTimeoutError);
    const waiting = withFileLock(lock, async () => 'after', { retryMs: 10 });
    await sleep(30);
    await rm(lock);
    expect(await waiting).toBe('after');
  });

  it('breaks a lock left by a dead process, or by one whose pid was recycled', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined);
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12_345 })); // above any real pid
    expect(await withFileLock(lock, async () => 'dead owner', { timeoutMs: 200 })).toBe('dead owner');
    // A running pid is not the owner of a lock taken before this boot, or
    // before that pid's process started.
    const boot = Date.now() - uptime() * 1000;
    await writeFile(lock, JSON.stringify({ pid: process.ppid, at: boot - 60_000 }));
    expect(await withFileLock(lock, async () => 'before boot', { timeoutMs: 2_000 })).toBe('before boot');
    await writeFile(lock, JSON.stringify({ pid: process.ppid, at: boot + 1_000 }));
    expect(await withFileLock(lock, async () => 'recycled', { timeoutMs: 2_000, staleMs: 30 })).toBe('recycled');
    // pid 1 runs since boot, so it may own a lock taken a minute ago: however
    // old, the lock stays.
    await writeFile(lock, JSON.stringify({ pid: 1, at: Date.now() - 60_000 }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await expect(withFileLock(lock, async () => 'never', { timeoutMs: 300, staleMs: 30, retryMs: 10 }))
      .rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it('leaves a lock alone when another process retook it while the contender claimed it', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined); // creates the directory
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12_345 })); // a dead owner
    const retaken = JSON.stringify({ pid: process.ppid, at: Date.now() }); // a live process
    const retake = () => writeFile(lock, retaken);
    await expect(withFileLock(lock, async () => 'entered', { staleMs: 30_000, timeoutMs: 150, retryMs: 10, beforeReclaim: retake }))
      .rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(await readFile(lock, 'utf8')).toBe(retaken);
    expect((await readdir(dirname(lock))).filter((name) => name.includes('.reclaim-'))).toEqual([]);
  });

  it('queues relative and absolute spellings of the same lock together', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined); // creates the directory
    const order: string[] = [];
    const task = (name: string, path: string) => withFileLock(path, async () => {
      order.push(`${name}:start`);
      await sleep(20);
      order.push(`${name}:end`);
    }, { timeoutMs: 1_000, retryMs: 5 });
    const relativeSpelling = relative(process.cwd(), join(dirname(lock), '.', '..', 'nested', basename(lock)));
    await Promise.all([task('absolute', lock), task('relative', relativeSpelling)]);
    expect(order).toEqual(['absolute:start', 'absolute:end', 'relative:start', 'relative:end']);
  });

  it('never lets a contender in while another process holds the lock, even paused past the stale window', async () => {
    const lock = await lockPath();
    const log = `${lock}.log`;
    // A separate process (Node strips the module's types) records entering and
    // leaving its critical section; it is paused inside it for several stale
    // windows, as a hung or suspended holder would be.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { appendFile } from 'node:fs/promises';
      const { withFileLock } = await import(${JSON.stringify(LOCK_MODULE)});
      await withFileLock(${JSON.stringify(lock)}, async () => {
        await appendFile(${JSON.stringify(log)}, 'child:start\\n');
        process.stdout.write('locked\\n');
        await new Promise((resolve) => setTimeout(resolve, 300));
        await appendFile(${JSON.stringify(log)}, 'child:end\\n');
      }, { staleMs: 150 });
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('locked')) resolve(); });
      child.on('exit', () => reject(new Error('child exited before locking')));
    });
    child.kill('SIGSTOP');
    try {
      await sleep(400); // well past the stale window
      await expect(withFileLock(lock, async () => 'entered', { staleMs: 150, timeoutMs: 400, retryMs: 10 }))
        .rejects.toBeInstanceOf(FileLockTimeoutError);
    } finally {
      child.kill('SIGCONT');
    }
    await withFileLock(lock, async () => appendFile(log, 'parent:start\nparent:end\n'), { staleMs: 150, timeoutMs: 5_000, retryMs: 10 });
    expect(await exited).toBe(0);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['child:start', 'child:end', 'parent:start', 'parent:end']);
  }, 15_000);

  it('lets only one of two processes reclaiming the same abandoned lock in at a time', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined); // creates the directory
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12_345 })); // a dead owner
    const inside = `${lock}.inside`;
    const overlap = `${lock}.overlap`;
    // Each reclaimer pauses once it judged the lock abandoned, until its go
    // file appears; its critical section records any overlap with the other.
    const reclaimer = (name: string) => {
      const go = `${lock}.go-${name}`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { access, appendFile, rm, writeFile } from 'node:fs/promises';
        const { withFileLock } = await import(${JSON.stringify(LOCK_MODULE)});
        const exists = (path) => access(path).then(() => true, () => false);
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await withFileLock(${JSON.stringify(lock)}, async () => {
          if (await exists(${JSON.stringify(inside)})) await writeFile(${JSON.stringify(overlap)}, ${JSON.stringify(name)});
          await writeFile(${JSON.stringify(inside)}, ${JSON.stringify(name)});
          process.stdout.write('entered\\n');
          await sleep(300);
          await rm(${JSON.stringify(inside)}, { force: true });
        }, {
          retryMs: 10,
          timeoutMs: 10_000,
          beforeReclaim: async () => {
            process.stdout.write('inspected\\n');
            while (!(await exists(${JSON.stringify(go)}))) await sleep(10);
          },
        });
      `], { stdio: ['ignore', 'pipe', 'inherit'] });
      let output = '';
      const waiters: Array<() => void> = [];
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); waiters.splice(0).forEach((wake) => wake()); });
      const said = (line: string) => new Promise<void>((resolve, reject) => {
        const check = () => (output.includes(line) ? resolve() : waiters.push(check));
        child.on('exit', () => reject(new Error(`${name} exited before printing ${line}`)));
        check();
      });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      return { said, exited, release: () => writeFile(go, 'go') };
    };
    const a = reclaimer('a');
    const b = reclaimer('b');
    await Promise.all([a.said('inspected'), b.said('inspected')]);
    // Both saw the same abandoned lock. One reclaims it and enters; only then
    // does the other continue, and it must not remove the fresh lock.
    await a.release();
    await a.said('entered');
    await b.release();
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    await expect(access(overlap)).rejects.toThrow();
    expect((await readdir(dirname(lock))).filter((name) => name.includes('.reclaim-'))).toEqual([]);
  }, 20_000);

  it('lets only one of two processes reclaim a lock whose first reclaimer died mid-claim', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined); // creates the directory
    const dead = JSON.stringify({ pid: 2 ** 22 + 12_345 });
    await writeFile(lock, dead);
    // The first reclaimer died holding its claim on that abandoned lock.
    const claim = `${lock}.reclaim-${createHash('sha256').update(dead).digest('hex').slice(0, 16)}`;
    await writeFile(claim, JSON.stringify({ pid: 2 ** 22 + 12_346 }));
    const inside = `${lock}.inside`;
    const overlap = `${lock}.overlap`;
    // Each reclaimer pauses once it judged the dead claim abandoned too.
    const reclaimer = (name: string) => {
      const go = `${lock}.go-${name}`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { access, rm, writeFile } from 'node:fs/promises';
        const { withFileLock } = await import(${JSON.stringify(LOCK_MODULE)});
        const exists = (path) => access(path).then(() => true, () => false);
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await withFileLock(${JSON.stringify(lock)}, async () => {
          if (await exists(${JSON.stringify(inside)})) await writeFile(${JSON.stringify(overlap)}, ${JSON.stringify(name)});
          await writeFile(${JSON.stringify(inside)}, ${JSON.stringify(name)});
          process.stdout.write('entered\\n');
          await sleep(300);
          await rm(${JSON.stringify(inside)}, { force: true });
        }, {
          retryMs: 10,
          timeoutMs: 10_000,
          beforeReclaim: async (path) => {
            if (path === ${JSON.stringify(claim)}) return;
            process.stdout.write('inspected\\n');
            while (!(await exists(${JSON.stringify(go)}))) await sleep(10);
          },
        });
      `], { stdio: ['ignore', 'pipe', 'inherit'] });
      let output = '';
      const waiters: Array<() => void> = [];
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); waiters.splice(0).forEach((wake) => wake()); });
      const said = (line: string) => new Promise<void>((resolve, reject) => {
        const check = () => (output.includes(line) ? resolve() : waiters.push(check));
        child.on('exit', () => reject(new Error(`${name} exited before printing ${line}`)));
        check();
      });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      return { said, exited, release: () => writeFile(go, 'go') };
    };
    const a = reclaimer('a');
    const b = reclaimer('b');
    await Promise.all([a.said('inspected'), b.said('inspected')]);
    await a.release();
    await a.said('entered');
    await b.release();
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    await expect(access(overlap)).rejects.toThrow();
    expect((await readdir(dirname(lock))).filter((name) => name.includes('.reclaim-'))).toEqual([]);
  }, 20_000);
});
