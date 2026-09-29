import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStartedJobs, rememberStartedJob } from './job-session';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('tab-local wallet job ownership', () => {
  it('restores started jobs after a reload', () => {
    const jobs = rememberStartedJob(readStartedJobs(), 'job-1');
    rememberStartedJob(jobs, 'job-2');
    expect([...readStartedJobs()]).toEqual(['job-1', 'job-2']);
  });

  it('does not restore jobs in a separate storage session', () => {
    rememberStartedJob(new Set(), 'job-1');
    vi.stubGlobal('sessionStorage', { getItem: () => null });
    expect(readStartedJobs().size).toBe(0);
  });

  it.each(['not json', '{}', '[1, null, "job-1"]'])('handles invalid stored data: %s', value => {
    sessionStorage.setItem('ants.dashboard.started-jobs', value);
    expect([...readStartedJobs()]).toEqual(value.startsWith('[') ? ['job-1'] : []);
  });

  it('keeps current-session auto prompting available when storage is blocked', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('Blocked'); },
      setItem: () => { throw new Error('Blocked'); },
    });
    expect(readStartedJobs().size).toBe(0);
    expect([...rememberStartedJob(new Set(), 'job-1')]).toEqual(['job-1']);
  });

  it('bounds the stored history and keeps the newest job', () => {
    const jobs = new Set(Array.from({ length: 100 }, (_, index) => `job-${index}`));
    const next = rememberStartedJob(jobs, 'job-new');
    expect(next.size).toBe(100);
    expect(next.has('job-0')).toBe(false);
    expect(readStartedJobs().has('job-new')).toBe(true);
  });
});
