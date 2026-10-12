const KEY = 'ants.dashboard.started-jobs';

export function readStartedJobs(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-100) : []);
  } catch {
    return new Set();
  }
}

export function rememberStartedJob(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set([...ids, id].slice(-100));
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {}
  return next;
}
