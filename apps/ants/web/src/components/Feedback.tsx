import { Alert, Button, Skeleton as UiSkeleton } from './ui';

export function Skeleton({ rows = 4, width }: { rows?: number; width?: string }) {
  return (
    <div className="skel-list" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <UiSkeleton key={i} height={14} width={width ?? `${60 + ((i * 17) % 40)}%`} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry, title }: { error: string; onRetry?: () => void; title?: string }) {
  return (
    <Alert
      tone="danger"
      title={title}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      <span className="break">{error}</span>
    </Alert>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}
