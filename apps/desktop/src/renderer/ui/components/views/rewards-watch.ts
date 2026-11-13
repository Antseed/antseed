import type { GatewayRewardsSummary } from '../../../types/bridge';

/** How often a screen showing the rewards reads them again while it is open, for usage earned meanwhile. */
export const REWARDS_REFRESH_MS = 60_000;

type RewardsRead = { ok: boolean; data?: GatewayRewardsSummary; error?: string } | undefined;

/**
 * Reads the rewards now, when the window regains focus (e.g. after claiming
 * in the console) and every `intervalMs`. A failed read keeps what is shown
 * and goes to `onError`; an answer overtaken by a newer read, or arriving
 * after stop, is dropped. Returns stop.
 */
export function watchRewards(
  read: () => Promise<RewardsRead> | undefined,
  show: (rewards: GatewayRewardsSummary) => void,
  { target = window, intervalMs = REWARDS_REFRESH_MS, onError }: {
    target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
    intervalMs?: number
    onError?: (error: string) => void
  } = {},
): () => void {
  let stopped = false;
  let generation = 0;
  const refresh = () => {
    const current = ++generation;
    const settle = (apply: () => void) => { if (!stopped && current === generation) apply(); };
    void Promise.resolve()
      .then(read)
      .then((result) => {
        if (!result) return;
        if (result.ok && result.data) settle(() => show(result.data!));
        else settle(() => onError?.(result.error ?? 'Could not read your rewards'));
      })
      .catch((err: unknown) => settle(() => onError?.(err instanceof Error ? err.message : String(err))));
  };
  refresh();
  target.addEventListener('focus', refresh);
  const timer = setInterval(refresh, intervalMs);
  return () => {
    stopped = true;
    target.removeEventListener('focus', refresh);
    clearInterval(timer);
  };
}
