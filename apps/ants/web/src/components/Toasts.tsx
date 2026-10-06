import { useJobs } from '../jobs';
import { TxLink } from './Activity';
import { CloseIcon, StatusIcon } from './icons';
import { IconButton } from './ui';

/** Bottom-right stack of transaction notifications (confirmed steps, completion, failures). */
export function Toasts() {
  const { toasts, dismissToast } = useJobs();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="region" aria-label="Transaction notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role={toast.tone === 'danger' ? 'alert' : 'status'}>
          <StatusIcon status={toast.tone === 'danger' ? 'failed' : toast.tone === 'info' ? 'running' : 'done'} />
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            {toast.body ? <div className="toast-text">{toast.body}</div> : null}
            {toast.hash ? <TxLink hash={toast.hash} /> : null}
            {toast.link ? <a className="toast-link" href={toast.link.href}>{toast.link.label} →</a> : null}
          </div>
          <IconButton label="Dismiss" className="toast-close" onClick={() => dismissToast(toast.id)}>
            <CloseIcon />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
