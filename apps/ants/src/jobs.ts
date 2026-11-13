import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobView, JobStep } from './api-types.js';
import type { StepReporter } from './service/steps.js';

const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Job runner with optional activity persistence for multi-transaction actions. The dashboard starts a
 * job, then polls it for step-by-step progress (transaction hashes included)
 * instead of holding one HTTP request open across several confirmations.
 */
export class JobRunner {
  private readonly jobs = new Map<string, JobView>();
  private active: string | null = null;
  private acceptingWrites = true;

  /** `onFinish` runs after every job, successful or not, before its final status is visible. */
  constructor(private readonly options: { onFinish?: () => void; journalPath?: string } = {}) {
    if (!options.journalPath) return;
    let records: unknown;
    try {
      records = JSON.parse(readFileSync(options.journalPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Could not read saved activity. Preserve the activity file and resolve the error before starting the dashboard.', { cause: error });
    }
    if (!Array.isArray(records)) throw new Error('Invalid saved activity file.');
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || typeof record.kind !== 'string' || !['running', 'done', 'failed'].includes(record.status) || !Number.isFinite(record.startedAt) || (record.owner !== undefined && typeof record.owner !== 'string') || !Array.isArray(record.steps) || !record.steps.every((step: JobStep) => step && typeof step.label === 'string' && Number.isFinite(step.at) && (step.hash === undefined || typeof step.hash === 'string'))) {
        throw new Error('Invalid saved activity record.');
      }
      const job = record as JobView;
      if (job.status === 'running') {
        job.status = 'failed';
        job.finishedAt = Date.now();
        job.error = 'The server stopped before completion was recorded. Transactions may have succeeded. Check the wallet and transaction links before retrying; this action was not automatically resubmitted.';
      }
      this.jobs.set(job.id, job);
    }
    this.prune();
    this.persist();
  }

  private persist(): void {
    if (!this.options.journalPath) return;
    mkdirSync(dirname(this.options.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.journalPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.jobs.values()]), { mode: 0o600 });
    renameSync(temporary, this.options.journalPath);
  }

  /** All jobs, or only those started for `owner` (case-insensitive address match). */
  list(owner?: string): JobView[] {
    this.prune();
    const all = [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    if (!owner) return all;
    return all.filter((job) => job.owner?.toLowerCase() === owner.toLowerCase());
  }

  get(id: string): JobView | undefined {
    this.prune();
    return this.jobs.get(id);
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** Atomically stop new jobs before replacing a wallet or network. */
  pauseWrites(): void {
    if (this.busy) throw new Error('A staking action is still running. Wait for it to finish before changing wallets or networks.');
    this.acceptingWrites = false;
  }

  /** Run `work` as a job. Only one signing job runs at a time so nonces stay ordered. */
  start(kind: string, work: (report: StepReporter) => Promise<unknown>, owner?: string): JobView {
    if (!this.acceptingWrites) throw new Error('This staking session has ended. Reopen Staking to continue.');
    if (this.active && this.jobs.get(this.active)?.status === 'running') {
      throw new Error(`Another action (${this.jobs.get(this.active)?.kind}) is still running. Wait for it to finish.`);
    }
    const job: JobView = { id: randomUUID(), kind, status: 'running', steps: [], startedAt: Date.now(), ...(owner ? { owner } : {}) };
    this.jobs.set(job.id, job);
    try {
      this.prune();
      this.persist();
    } catch (error) {
      this.jobs.delete(job.id);
      throw new Error('Could not save activity. No action was started.', { cause: error });
    }
    this.active = job.id;
    const report: StepReporter = (label, hash) => {
      const step: JobStep = { at: Date.now(), label, ...(hash ? { hash } : {}) };
      job.steps.push(step);
      this.persist();
    };
    void (async () => {
      try {
        job.result = await work(report);
        job.status = 'done';
      } catch (error) {
        job.status = 'failed';
        job.error = describeError(error);
      } finally {
        try {
          this.options.onFinish?.();
        } catch (error) {
          job.status = 'failed';
          job.error = `${job.error ?? 'The action finished.'} Refresh failed: ${describeError(error)}. Check transaction status before retrying.`;
        }
        job.finishedAt = Date.now();
        if (this.active === job.id) this.active = null;
        try {
          this.persist();
        } catch {
          job.status = 'failed';
          job.error = `${job.error ?? 'The action finished.'} Activity could not be saved. Check transaction status before retrying.`;
        }
      }
    })();
    return job;
  }

  private prune(): void {
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && (job.finishedAt ?? job.startedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

/** Turn ethers/RPC errors into one readable line. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const candidate = error as Error & { reason?: string; shortMessage?: string; info?: { error?: { message?: string } }; code?: string };
  const revert = candidate.reason ?? candidate.info?.error?.message;
  if (revert && revert !== candidate.message) return `${candidate.shortMessage ?? candidate.message} (${revert})`;
  return candidate.shortMessage ?? candidate.message;
}
