import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { BottomNotice } from './BottomNotice';
import { dismissConsoleLaunchFailure, openGatewayConsole, useConsoleLaunchFailure } from '../../modules/app/console-launch';

/** Says why a link to the gateway console (Dashboard, API keys) didn't open. */
export function ConsoleLaunchNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  const failure = useConsoleLaunchFailure();
  if (!failure) return null;
  return (
    <BottomNotice
      actions={[
        { label: 'Try again', onClick: () => { void openGatewayConsole(failure.path); } },
        { label: 'Gateway settings', onClick: () => { dismissConsoleLaunchFailure(); onOpenSettings(); } },
      ]}
      body={failure.error}
      dismissLabel="Dismiss"
      icon={<HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.8} />}
      onDismiss={dismissConsoleLaunchFailure}
      role="alert"
      title="Couldn't open your gateway console"
      tone="danger"
    />
  );
}
