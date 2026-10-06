import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { useUiSelector } from '../hooks/useUiSelector';
import type { RendererUiState } from '../../core/state';
import { BottomNotice } from './BottomNotice';

type AlertKind = RendererUiState['networkAlert'];

const MESSAGES: Record<Exclude<AlertKind, 'none'>, { title: string; body: string }> = {
  'no-internet': {
    title: 'No internet connection',
    body: 'AI VPN can’t reach the peer-to-peer network. Check your connection — requests won’t work until you’re back online.',
  },
  blocked: {
    title: 'Peer-to-peer network unreachable',
    body: 'A firewall or VPN on this network appears to be blocking peer-to-peer (UDP) traffic, so providers can’t be discovered. Try disconnecting the VPN or switching to a less restrictive network.',
  },
  'no-peers': {
    title: 'No providers found',
    body: 'You’re connected, but no providers are reachable right now. If you’re on a VPN or a restrictive network, it may be blocking peer-to-peer traffic.',
  },
};

export function NetworkAlertBanner() {
  const alert = useUiSelector((state) => state.networkAlert);
  const [dismissed, setDismissed] = useState<AlertKind>('none');

  // A resolved alert clears the dismissal so a future problem shows again.
  useEffect(() => {
    if (alert === 'none') setDismissed('none');
  }, [alert]);

  if (alert === 'none' || alert === dismissed) return null;
  const msg = MESSAGES[alert];

  return (
    <BottomNotice
      align="start"
      body={msg.body}
      dismissLabel="Dismiss network warning"
      icon={<HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.8} />}
      onDismiss={() => setDismissed(alert)}
      role="alert"
      title={msg.title}
      tone="danger"
    />
  );
}
