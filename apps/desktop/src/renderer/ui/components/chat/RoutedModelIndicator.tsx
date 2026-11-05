import { HugeiconsIcon } from '@hugeicons/react';
import { AiBrain01Icon } from '@hugeicons/core-free-icons';
import type { ChatMessage } from './chat-shared';
import styles from './ChatBubble.module.scss';

/** The gateway model id that produced an assistant reply, when it was recorded. */
export function replyModelLabel(message: ChatMessage): string | null {
  if (message.role !== 'assistant') return null;
  const service = message.meta?.service;
  return typeof service === 'string' && service.trim() ? service.trim() : null;
}

/** Names the model a reply came from (the gateway picks the seller behind it). */
export function RoutedModelIndicator({ message }: { message: ChatMessage }) {
  const label = replyModelLabel(message);
  return label ? (
    <span className={styles.routedModel} title={`Answered by ${label}`}>
      <HugeiconsIcon icon={AiBrain01Icon} size={13} aria-hidden="true" />
      <span>{label}</span>
    </span>
  ) : null;
}
