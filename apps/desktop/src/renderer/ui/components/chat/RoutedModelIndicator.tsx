import { HugeiconsIcon } from '@hugeicons/react';
import { HierarchyIcon } from '@hugeicons/core-free-icons';
import { displayModelLabel } from '../../../modules/catalog/model-identity';
import { shortPeerId } from '../../../modules/routing/tools';
import { useUiSelector } from '../../hooks/useUiSelector';
import type { ChatMessage } from './chat-shared';
import styles from './ChatBubble.module.scss';

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * Where a reply was routed. A model the user chose names only the seller that served it
 * ("Open Forge"); a model a routing service chose names the model and the seller
 * ("GLM 5.3 Flash · Open Forge"). `peerName` resolves a seller name for replies saved
 * before the name was recorded; a short peer id is the last resort.
 */
export function routedModelLabel(message: ChatMessage, peerName?: (peerId: string) => string | null): string | null {
  if (message.role !== 'assistant') return null;
  const meta = message.meta ?? {};
  const value = text(meta.service);
  const service = value?.split('@').at(-1);
  const peerId = text(meta.peerId);
  const seller = text(meta.peerName) ?? (peerId ? peerName?.(peerId) ?? shortPeerId(peerId) : null);
  if (!text(meta.router)) return seller;
  if (!service || service === 'antseed') return null;
  const model = displayModelLabel(service, service);
  return seller ? `${model} · ${seller}` : model;
}

export function RoutedModelIndicator({ message }: { message: ChatMessage }) {
  const rows = useUiSelector((state) => state.vprRoutableRows);
  const label = routedModelLabel(message, (peerId) => {
    const row = rows.find((candidate) => candidate.peerId === peerId);
    return row?.peerDisplayName?.trim() || row?.peerLabel?.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
  });
  return label ? <span className={styles.routedModel} title={`Served by ${label}`}>
    <HugeiconsIcon icon={HierarchyIcon} size={13} aria-hidden="true" />
    <span>Routed to {label}</span>
  </span> : null;
}
