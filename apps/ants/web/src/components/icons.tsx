import type { JobView } from '../../../src/api-types';
import { Spinner } from './Feedback';

/* Small inline SVG glyphs for the activity UI. All stroke `currentColor` so the tone comes from CSS. */

export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.2l2.4 2.4 4.6-4.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Round status badge: spinner while running, green check when done, red cross when failed. */
export function StatusIcon({ status }: { status: JobView['status'] }) {
  if (status === 'running') {
    return (
      <span className="status-icon status-icon--running" title="Pending">
        <Spinner />
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="status-icon status-icon--done" title="Confirmed">
        <CheckGlyph />
      </span>
    );
  }
  return (
    <span className="status-icon status-icon--failed" title="Failed">
      <CrossGlyph />
    </span>
  );
}
