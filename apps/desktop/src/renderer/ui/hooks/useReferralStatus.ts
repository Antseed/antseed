import { useCallback, useEffect, useState } from 'react';
import type { ReferralStatus } from '../../types/bridge';

/**
 * This wallet's referral status, read on mount. `reload` reads it again (e.g.
 * after an invite is redeemed: a pending invite binds with the first paid or
 * free request) and returns a cleanup that drops a read still in flight.
 */
export function useReferralStatus(): { status: ReferralStatus | null; reload: () => () => void } {
  const [status, setStatus] = useState<ReferralStatus | null>(null);
  const reload = useCallback(() => {
    let cancelled = false;
    void window.antseedDesktop?.referralGetStatus?.()
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(reload, [reload]);
  return { status, reload };
}
