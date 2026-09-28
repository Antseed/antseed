import { HugeiconsIcon } from '@hugeicons/react';
import { HierarchyIcon } from '@hugeicons/core-free-icons';
import { displayModelLabel } from '../../../modules/catalog/model-identity';
import type { ChatMessage } from './chat-shared';
import styles from './ChatBubble.module.scss';

export function routedModelLabel(message: ChatMessage): string | null {
  if (message.role !== 'assistant') return null;
  const value = message.meta?.service;
  if (typeof value !== 'string' || !value.trim()) return null;
  const service = value.trim().split('@').at(-1)!;
  if (service === 'antseed' || service === 'levanto-auto') return null;
  return displayModelLabel(service, service);
}

export function RoutedModelIndicator({ message }: { message: ChatMessage }) {
  const label = routedModelLabel(message);
  return label ? <span className={styles.routedModel} title={`Model used for this response: ${label}`}>
    <HugeiconsIcon icon={HierarchyIcon} size={13} aria-hidden="true" />
    <span>Routed to {label}</span>
  </span> : null;
}
