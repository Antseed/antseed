import { useEffect } from 'react';
import type { JobView } from '../../../src/api-types';
import { useConfig } from '../app-context';
import { explorerName, explorerTxUrl, formatRelativeTime, shortHash } from '../format';
import { useNow } from '../hooks';
import { jobTitle, useJobs } from '../jobs';
import { Spinner } from './Feedback';
import { ClockIcon, CloseIcon, StatusIcon } from './icons';
import { Button, IconButton } from './ui';

/* ---------- Header indicator ---------- */

/** "1 pending" pill with a spinner while a job runs; a quiet "Activity" button otherwise. Both open the drawer. */
export function ActivityIndicator() {
  const { pending, running, setDrawerOpen } = useJobs();
  if (running) {
    return (
      <button type="button" className="activity-pill" onClick={() => setDrawerOpen(true)} aria-live="polite">
        <Spinner />
        <span>
          {pending} pending
        </span>
      </button>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={() => setDrawerOpen(true)} leadingIcon={<ClockIcon />}>
      Activity
    </Button>
  );
}

/* ---------- Explorer link ---------- */

/** "View on Basescan" for chains with an explorer; otherwise the short hash as plain text. */
export function TxLink({ hash, showHash = false }: { hash: string; showHash?: boolean }) {
  const { evmChainId } = useConfig();
  const url = explorerTxUrl(evmChainId, hash);
  const name = explorerName(evmChainId);
  if (!url || !name) {
    return (
      <span className="activity-hash mono" title={hash}>
        {shortHash(hash)}
      </span>
    );
  }
  return (
    <span className="activity-link-wrap">
      <a className="activity-link" href={url} target="_blank" rel="noreferrer" title={hash}>
        View on {name}
      </a>
      {showHash ? <span className="activity-hash mono dim">{shortHash(hash)}</span> : null}
    </span>
  );
}

/* ---------- Drawer ---------- */

export function ActivityDrawer() {
  const { drawerOpen, setDrawerOpen } = useJobs();
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, setDrawerOpen]);
  if (!drawerOpen) return null;
  const close = () => setDrawerOpen(false);
  return (
    <>
      <div className="drawer-backdrop" onClick={close} />
      <aside className="drawer activity-drawer" role="dialog" aria-modal="true" aria-label="Activity">
        <header className="drawer-header">
          <div className="drawer-titles">
            <h2 className="drawer-title">Activity</h2>
          </div>
          <IconButton label="Close" className="drawer-close" onClick={close}>
            <CloseIcon />
          </IconButton>
        </header>
        <div className="drawer-body">
          <ActivityList />
        </div>
      </aside>
    </>
  );
}

function ActivityList() {
  const { jobs, pollError } = useJobs();
  const now = useNow(1000);
  return (
    <>
      {jobs.length === 0 ? (
        <div className="activity-empty">No recorded transactions. Signed-wallet activity is saved locally for 30 days.</div>
      ) : (
        <ol className="activity-list">
          {jobs.map((job) => (
            <ActivityRow key={job.id} job={job} now={now} />
          ))}
        </ol>
      )}
      {pollError ? <div className="activity-poll-error">Could not refresh activity: {pollError}</div> : null}
    </>
  );
}

function ActivityRow({ job, now }: { job: JobView; now: number }) {
  const hashed = job.steps.filter((step) => step.hash);
  const subtitle = job.steps[0]?.label;
  return (
    <li className={`activity-row activity-row--${job.status}`}>
      <div className="activity-main">
        <div className="activity-title">{jobTitle(job.kind)}</div>
        {subtitle ? <div className="activity-sub">{subtitle}</div> : null}
        {job.steps.length > 1 ? <details><summary>Action steps</summary><ol>{job.steps.map((step, index) => <li key={index}>{step.label}</li>)}</ol></details> : null}
        {job.status === 'failed' && job.error ? <div className="activity-error">{job.error}</div> : null}
        {hashed.length > 0 ? (
          <div className="activity-links">
            {hashed.map((step) => (
              <TxLink key={step.hash} hash={step.hash as string} showHash={hashed.length > 1} />
            ))}
          </div>
        ) : null}
      </div>
      <div className="activity-side">
        <StatusIcon status={job.status} />
        <span className="activity-time">{formatRelativeTime(job.startedAt, now)}</span>
      </div>
    </li>
  );
}
