import type { ReactNode } from 'react';
import { Button } from '@antseed/ui';
import styles from './ChatNote.module.scss';

export type ChatNoteAction = {
  label: string;
  onClick: () => void;
  primary?: boolean;
};

/** Something went wrong with a request: a note in the conversation, where the answer would be. */
export function ChatNote({ children, actions = [] }: { children: ReactNode; actions?: ChatNoteAction[] }) {
  return (
    <div className={styles.note} role="alert">
      <span className={styles.icon} aria-hidden="true">!</span>
      <div className={styles.body}>
        <p className={styles.text}>{children}</p>
        {actions.length > 0 && (
          <div className={styles.actions}>
            {actions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.primary ? 'primary' : 'outline'}
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
