import type { ToolApprovalRequest } from '../../../types/bridge';
import styles from './ToolApprovalCard.module.scss';

type ToolApprovalCardProps = {
  request: ToolApprovalRequest | null;
  pendingCount?: number;
  onAllowOnce: () => void;
  onAlwaysAllow: () => void;
  onDeny: () => void;
};

function getModelLabel(request: ToolApprovalRequest): string {
  return request.modelName || request.modelId || 'this model';
}

function getToolLabel(toolName: string): string {
  return toolName.replace(/_/g, ' ');
}

function shortenSubject(subject: string, workspacePath: string): string {
  const trimmed = subject.trim();
  const workspace = workspacePath.trim().replace(/[\\/]+$/, '');
  if (!trimmed || !workspace) return trimmed;

  return trimmed
    .replaceAll(workspace, '.')
    .replaceAll(workspace.replace(/ /g, '\\ '), '.');
}

export function ToolApprovalCard({ request, pendingCount = 0, onAllowOnce, onAlwaysAllow, onDeny }: ToolApprovalCardProps) {
  if (!request) return null;

  const queuedCount = Math.max(0, pendingCount - 1);
  const modelLabel = getModelLabel(request);
  const toolLabel = getToolLabel(request.toolName);
  const subject = request.subject ? shortenSubject(request.subject, request.workspacePath) : '';
  const question = request.title;
  const permissionLabel = request.permissionLabel || `${toolLabel} requests`;
  const alwaysAllowTitle = `Future ${permissionLabel} from ${modelLabel} will run without asking.`;

  return (
    <div className={styles.approval} role="group" aria-label={question}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.kicker}>Tool approval · {modelLabel}</span>
          <span className={styles.title}>{question}</span>
        </div>
        {queuedCount > 0 ? <span className={styles.queueBadge}>{queuedCount} queued</span> : null}
      </div>

      <div className={styles.requestLine}>
        <span className={styles.tool}>{toolLabel}</span>
        {subject ? <code className={styles.subject} title={request.subject}>{subject}</code> : null}
      </div>

      {request.canAlwaysAllow ? (
        <div className={styles.scopeNote}>Always allow means future <strong>{permissionLabel}</strong> from <strong>{modelLabel}</strong> will not ask again.</div>
      ) : null}

      <div className={styles.actions}>
        <button type="button" className={styles.danger} onClick={onDeny}>Deny</button>
        {request.canAlwaysAllow ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={onAlwaysAllow}
            title={alwaysAllowTitle}
          >
            {request.alwaysAllowLabel}
          </button>
        ) : null}
        <button type="button" className={styles.primary} onClick={onAllowOnce}>Allow once</button>
      </div>
    </div>
  );
}
