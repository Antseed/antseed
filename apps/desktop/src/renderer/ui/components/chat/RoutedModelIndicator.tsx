import { HugeiconsIcon } from '@hugeicons/react';
import { AiBrain01Icon } from '@hugeicons/core-free-icons';
import { splitPinnedModel } from '../../../../shared/pinned-model.js';
import type { ChatMessage } from './chat-shared';
import styles from './ChatBubble.module.scss';

/** The gateway model id that produced an assistant reply, when it was recorded. */
export function replyModelLabel(message: ChatMessage): string | null {
  if (message.role !== 'assistant') return null;
  const service = message.meta?.service;
  if (typeof service !== 'string' || !service.trim()) return null;
  const model = splitPinnedModel(service.trim()).modelId;
  const seller = replySellerLabel(message);
  return seller ? `${model} · ${seller}` : model;
}

function replySellerLabel(message: ChatMessage): string | null {
  const { peerName, peerId } = message.meta ?? {};
  if (typeof peerName === 'string' && peerName.trim()) return peerName.trim();
  return typeof peerId === 'string' && peerId.trim() ? peerId.trim().slice(0, 8) : null;
}

/** Names the model a reply came from and the seller that served it. */
export function RoutedModelIndicator({ message }: { message: ChatMessage }) {
  const label = replyModelLabel(message);
  return label ? (
    <span className={styles.routedModel} title={`Answered by ${label}`}>
      <HugeiconsIcon icon={AiBrain01Icon} size={13} aria-hidden="true" />
      <span>{label}</span>
    </span>
  ) : null;
}
