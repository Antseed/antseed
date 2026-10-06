import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { JobView } from '../../src/api-types';
import { api } from './api';
import { invalidateAll } from './data';
import { href } from './router';
import { describeError } from './format';
import { readStartedJobs, rememberStartedJob } from './job-session';
import { useWalletReadiness } from './wallet-readiness';

/*
 * Session transaction state, modelled on Uniswap's transaction UX: a pending
 * pill in the header, an Activity drawer listing this session's jobs, and
 * confirmation toasts as each transaction step lands. The list is polled from
 * `/api/jobs` while the drawer is open or any job is running; toasts are
 * derived by diffing successive polls against what has already been announced.
 */

const POLL_MS = 2000;
const TOAST_MS = 8000;

export type ToastTone = 'success' | 'danger' | 'info';

export interface Toast {
  id: number;
  jobId?: string;
  tone: ToastTone;
  title: string;
  /** Free text under the title (error message). */
  body?: string;
  /** Transaction hash rendered as an explorer link under the title. */
  hash?: string;
  /** Sticky toasts stay until dismissed. */
  sticky: boolean;
  /** Optional follow-up link ("View my positions" after a stake). */
  link?: { href: string; label: string };
}

/** Jobs that create or grow a position; their completion toast links to the positions page. */
const POSITION_JOBS = new Set(['stake', 'restake', 'stake-usage', 'compound']);

export interface JobsValue {
  /** This session's jobs, newest first. */
  jobs: JobView[];
  locallyStartedJobIds: ReadonlySet<string>;
  /** Number of jobs still running (the server allows one at a time). */
  pending: number;
  running: boolean;
  drawerOpen: boolean;
  pollError: string | null;
  toasts: Toast[];
  setDrawerOpen: (open: boolean) => void;
  dismissToast: (id: number) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  titleForJob: (id: string) => string;
  /** POST an action; resolves with the running job (throws on 403/409/other errors). */
  start: (path: string, body: unknown) => Promise<JobView>;
}

const JobsContext = createContext<JobsValue | null>(null);

export function useJobs(): JobsValue {
  const value = useContext(JobsContext);
  if (!value) throw new Error('JobsContext is not mounted');
  return value;
}

const TITLES: Record<string, string> = {
  stake: 'Stake',
  move: 'Move stake',
  split: 'Split position',
  merge: 'Merge positions',
  extend: 'Extend lock',
  'max-lock': 'Max lock',
  withdraw: 'Withdraw',
  claim: 'Claim rewards',
  restake: 'Stake rewards',
  'stake-usage': 'Stake rewards',
  compound: 'Stake rewards',
  'verify-submit': 'Submit proof',
  'seller-register': 'Register seller',
  'claim-starter': 'Claim starter',
};

/** Human title for a job kind ("stake" → "Stake"); unknown kinds are capitalised. */
export function jobTitle(kind: string): string {
  const known = TITLES[kind];
  if (known) return known;
  const words = kind.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Transaction';
}

export function actionTitle(kind: string, body: unknown): string {
  const input = body as { positionId?: unknown; positionIds?: unknown } | null;
  const ids = Array.isArray(input?.positionIds) ? input.positionIds : [input?.positionId];
  const positions = ids.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  return `${jobTitle(kind)}${positions.length ? ` · position${positions.length > 1 ? 's' : ''} ${positions.map(id => `#${id}`).join(', ')}` : ''}`;
}

interface Seen {
  hashes: Set<string>;
  terminal: boolean;
}

function sortNewestFirst(jobs: JobView[]): JobView[] {
  return [...jobs].sort((a, b) => b.startedAt - a.startedAt);
}

export function JobsProvider({ children }: { children: ReactNode }) {
  const wallet = useWalletReadiness();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const labels = useRef(new Map<string, string>());
  const titleForJob = useCallback((id: string) => labels.current.get(id) ?? 'Transaction', []);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [locallyStartedJobIds, setLocallyStartedJobIds] = useState(readStartedJobs);
  const localJobIdsRef = useRef(locallyStartedJobIds);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenRef = useRef(new Map<string, Seen>());
  const toastIdRef = useRef(0);
  const timersRef = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = ++toastIdRef.current;
      setToasts((list) => [...list.filter(existing => !toast.jobId || existing.jobId !== toast.jobId), { ...toast, id }]);
      if (!toast.sticky) {
        timersRef.current.set(
          id,
          window.setTimeout(() => dismissToast(id), TOAST_MS),
        );
      }
    },
    [dismissToast],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /**
   * Merge a fresh job list into state and announce what changed. `silent`
   * (the reload pickup) records existing steps without toasting them, so only
   * steps that complete after reload produce notifications.
   */
  const ingest = useCallback(
    (list: JobView[], silent: boolean) => {
      let finished = false;
      let confirmed = false;
      for (const job of list) {
        if (!labels.current.has(job.id)) labels.current.set(job.id, jobTitle(job.kind));
        let seen = seenRef.current.get(job.id);
        if (!seen) {
          const historical = silent || (job.status !== 'running' && !localJobIdsRef.current.has(job.id));
          seen = { hashes: new Set(), terminal: historical && job.status !== 'running' };
          if (historical) for (const step of job.steps) if (step.hash) seen.hashes.add(step.hash);
          seenRef.current.set(job.id, seen);
        }
        for (const step of job.steps) {
          if (!step.hash || seen.hashes.has(step.hash)) continue;
          seen.hashes.add(step.hash);
          if (!silent) pushToast({ tone: 'success', jobId: job.id, title: `${titleForJob(job.id)} · Confirmed`, body: step.label, hash: step.hash, sticky: false });
        }
        if (job.status !== 'running' && !seen.terminal) {
          seen.terminal = true;
          finished = true;
          confirmed ||= job.steps.some(step => !!step.hash);
          if (job.status === 'failed') {
            pushToast({ tone: 'danger', jobId: job.id, title: `${titleForJob(job.id)} · ${job.error?.startsWith('You rejected') ? 'Rejected' : 'Failed'}`, body: job.error ?? 'The transaction did not complete.', sticky: true });
          } else if (!silent) {
            const link = POSITION_JOBS.has(job.kind) ? { href: href('positions'), label: 'View my positions' } : undefined;
            pushToast({ tone: 'success', jobId: job.id, title: `${titleForJob(job.id)} · ${job.steps.some(step => !!step.hash) ? 'Confirmed' : 'Complete'}`, hash: [...job.steps].reverse().find(step => !!step.hash)?.hash, sticky: !!link, link });
          }
        }
      }
      setJobs(sortNewestFirst(list));
      if (finished && !silent) invalidateAll({ confirmed });
    },
    [pushToast, titleForJob],
  );

  const silentRef = useRef(true);
  const refresh = useCallback(async () => {
    // Decide silence up front so an action started while this request is in flight cannot retroactively un-silence it.
    const silent = silentRef.current;
    try {
      const list = await api.jobs();
      ingest(list, silent);
      silentRef.current = false;
      setPollError(null);
    } catch (error) {
      setPollError(describeError(error));
    }
  }, [ingest]);

  // Pick up jobs (and any still-running job) after a page reload.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = useMemo(() => jobs.filter((job) => job.status === 'running').length, [jobs]);
  const running = pending > 0;

  // Poll while the drawer is open or anything is in flight; the first fetch is immediate so opening the drawer never shows stale rows.
  useEffect(() => {
    if (!drawerOpen && !running) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, running, refresh]);

  const start = useCallback(async (path: string, body: unknown) => {
    walletRef.current?.assertReady();
    const job = await api.startJob(path, body);
    labels.current.set(job.id, actionTitle(job.kind, body));
    localJobIdsRef.current = rememberStartedJob(localJobIdsRef.current, job.id);
    setLocallyStartedJobIds(localJobIdsRef.current);
    // A freshly started job is never silent: every hashed step it reports from here on is toasted.
    silentRef.current = false;
    if (!seenRef.current.has(job.id)) seenRef.current.set(job.id, { hashes: new Set(), terminal: false });
    setPollError(null);
    setJobs((list) => sortNewestFirst([job, ...list.filter((item) => item.id !== job.id)]));
    return job;
  }, []);

  const value = useMemo<JobsValue>(
    () => ({ jobs, locallyStartedJobIds, pending, running, drawerOpen, pollError, toasts, setDrawerOpen, dismissToast, pushToast, titleForJob, start }),
    [jobs, locallyStartedJobIds, pending, running, drawerOpen, pollError, toasts, dismissToast, pushToast, titleForJob, start],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}
