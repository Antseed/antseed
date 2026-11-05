import { useCallback, useRef, useState } from 'react';

/**
 * Open the staking dashboard on one seller's pool (its agent id), and keep
 * the launcher's failure so the link that asked can show it.
 */
export function useOpenSellerPool(): { open: (agentId: number) => void; opening: boolean; error: string } {
  const inFlight = useRef(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  const open = useCallback((agentId: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpening(true);
    setError('');
    void (async () => {
      try {
        const launch = window.antseedDesktop?.stakingOpen;
        if (!launch) throw new Error('Staking is available in the VPR desktop app.');
        const result = await launch({ page: 'stake', pool: agentId });
        if (!result.ok) throw new Error(result.error || 'Could not open Staking.');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not open Staking.');
      } finally {
        inFlight.current = false;
        setOpening(false);
      }
    })();
  }, []);

  return { open, opening, error };
}
