import { describe, expect, it, vi } from 'vitest';
import { JobRunner, describeError } from './jobs.js';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('JobRunner', () => {
  it('records refresh failures without invoking the callback twice or losing the result', async () => {
    let calls = 0;
    const runner = new JobRunner({ onFinish: () => { calls += 1; throw new Error('refresh failed'); } });
    const job = runner.start('stake', async () => ({ hash: '0xabc' }));
    await tick();
    expect(calls).toBe(1);
    expect(runner.get(job.id)).toMatchObject({ status: 'failed', result: { hash: '0xabc' }, error: expect.stringContaining('Check transaction status before retrying') });
  });

  it('persists confirmed steps and completed results across restarts', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ants-jobs-'));
    try {
      const journalPath = path.join(directory, 'activity.json');
      const runner = new JobRunner({ journalPath });
      const job = runner.start('register', async (report) => {
        await report('Identity created: agent 77', '0xabc');
        return { agentId: 77 };
      });
      await tick();
      const restarted = new JobRunner({ journalPath });
      expect(restarted.get(job.id)).toMatchObject({ status: 'done', result: { agentId: 77 }, steps: [{ hash: '0xabc' }] });
      expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('marks interrupted work for manual review and never resubmits it', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ants-jobs-'));
    try {
      const journalPath = path.join(directory, 'activity.json');
      writeFileSync(journalPath, JSON.stringify([{ id: 'interrupted', kind: 'stake', status: 'running', startedAt: Date.now(), steps: [{ at: Date.now(), label: 'Approval confirmed', hash: '0xabc' }] }]));
      const restarted = new JobRunner({ journalPath });
      expect(restarted.get('interrupted')).toMatchObject({ status: 'failed', error: expect.stringContaining('not automatically resubmitted') });
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))[0].status).toBe('failed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an unreadable activity journal', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ants-jobs-'));
    try {
      const journalPath = path.join(directory, 'activity.json');
      writeFileSync(journalPath, '{broken');
      expect(() => new JobRunner({ journalPath })).toThrow('Could not read saved activity');
      expect(readFileSync(journalPath, 'utf8')).toBe('{broken');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not execute an action when its journal cannot be saved', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ants-jobs-'));
    try {
      const journalPath = path.join(directory, 'parent', 'activity.json');
      const runner = new JobRunner({ journalPath });
      writeFileSync(path.join(directory, 'parent'), 'not a directory');
      let executed = false;
      expect(() => runner.start('stake', async () => { executed = true; })).toThrow('No action was started');
      expect(executed).toBe(false);
      expect(runner.list()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs onFinish before a job reports done or failed', async () => {
    const seen: string[] = [];
    const runner = new JobRunner({ onFinish: () => seen.push('finish') });
    const ok = runner.start('stake', async () => 'ok');
    await tick();
    expect(runner.get(ok.id)?.status).toBe('done');
    const bad = runner.start('move', async () => { throw new Error('nope'); });
    await tick();
    expect(runner.get(bad.id)?.status).toBe('failed');
    expect(seen).toEqual(['finish', 'finish']);
  });

  it('records steps, results, and refuses concurrent signing jobs', async () => {
    const runner = new JobRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job = runner.start('stake', async (report) => {
      await report('approving');
      await gate;
      await report('confirmed', '0xabc');
      return { hash: '0xabc' };
    });
    expect(job.status).toBe('running');
    await tick();
    expect(() => runner.start('move', async () => undefined)).toThrow(/still running/);
    release();
    await tick();
    const done = runner.get(job.id)!;
    expect(done.status).toBe('done');
    expect(done.steps.map((step) => step.label)).toEqual(['approving', 'confirmed']);
    expect(done.steps[1]?.hash).toBe('0xabc');
    expect(done.result).toEqual({ hash: '0xabc' });
    expect(runner.start('move', async () => undefined).status).toBe('running');
  });

  it('captures failures as readable errors', async () => {
    const runner = new JobRunner();
    const job = runner.start('claim', async () => { throw Object.assign(new Error('execution reverted'), { reason: 'NothingToClaim()' }); });
    await tick();
    expect(runner.get(job.id)?.status).toBe('failed');
    expect(runner.get(job.id)?.error).toBe('execution reverted (NothingToClaim())');
    expect(describeError('plain')).toBe('plain');
  });
});

it('refuses session replacement during work and prevents new jobs after pausing', async () => {
  const runner = new JobRunner();
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  runner.start('claim', () => completion);
  expect(runner.busy).toBe(true);
  expect(() => runner.pauseWrites()).toThrow(/still running/);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runner.busy).toBe(false);
  runner.pauseWrites();
  const work = vi.fn();
  expect(() => runner.start('stake', work)).toThrow(/session has ended/);
  expect(work).not.toHaveBeenCalled();
});

it('lists only the owner\'s jobs when an owner filter is given', async () => {
  const runner = new JobRunner();
  const a = runner.start('stake', async () => 1, '0x00000000000000000000000000000000000000AA');
  await vi.waitFor(() => expect(runner.get(a.id)?.status).toBe('done'));
  const b = runner.start('claim', async () => 2, '0x00000000000000000000000000000000000000bb');
  await vi.waitFor(() => expect(runner.get(b.id)?.status).toBe('done'));
  expect(runner.list().map((job) => job.id)).toEqual([b.id, a.id]);
  expect(runner.list('0x00000000000000000000000000000000000000aa').map((job) => job.id)).toEqual([a.id]);
  expect(runner.list('0x00000000000000000000000000000000000000BB').map((job) => job.id)).toEqual([b.id]);
});
