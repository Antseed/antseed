import type { GatewayRewardsSummary } from '../../../types/bridge';

/** How often Home reads the rewards again while it is open, for usage earned meanwhile. */
export const REWARDS_REFRESH_MS = 60_000;

type RewardsRead = { ok: boolean; data?: GatewayRewardsSummary; error?: string } | undefined;

/**
 * Reads the rewards now, when the window regains focus (e.g. after claiming
 * in the console) and every `intervalMs`. A failed read keeps what is shown;
 * an answer overtaken by a newer read, or arriving after stop, is dropped.
 * Returns stop.
 */
export function watchRewards(
  read: () => Promise<RewardsRead> | undefined,
  show: (rewards: GatewayRewardsSummary) => void,
  { target = window, intervalMs = REWARDS_REFRESH_MS }: { target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>; intervalMs?: number } = {},
): () => void {
  let stopped = false;
  let generation = 0;
  const refresh = () => {
    const current = ++generation;
    void Promise.resolve()
      .then(read)
      .then((result) => {
        if (!stopped && current === generation && result?.ok && result.data) show(result.data);
      })
      .catch(() => {});
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
