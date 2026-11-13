import { describe, expect, it } from 'vitest';
import {
  BuyerAlreadyActiveError,
  BuyerTabLock,
  type WebLockLike,
  type WebLockManagerLike,
} from './tab-lock.js';

describe('BuyerTabLock', () => {
  it('allows only one active tab and releases cleanly', async () => {
    const manager = new FakeLockManager();
    const first = await BuyerTabLock.acquire('buyer-a', manager);

    await expect(BuyerTabLock.acquire('buyer-a', manager)).rejects.toBeInstanceOf(
      BuyerAlreadyActiveError,
    );

    await first.release();
    const successor = await BuyerTabLock.acquire('buyer-a', manager);
    await successor.release();
  });

  it('does not make different buyer identities contend', async () => {
    const manager = new FakeLockManager();
    const first = await BuyerTabLock.acquire('buyer-a', manager);
    const second = await BuyerTabLock.acquire('buyer-b', manager);
    await Promise.all([first.release(), second.release()]);
  });

  it('waits for the active buyer lock when requested', async () => {
    const manager = new FakeLockManager();
    const first = await BuyerTabLock.acquire('buyer-a', manager);
    let acquired = false;
    const waiting = BuyerTabLock.acquire('buyer-a', manager, { wait: true })
      .then((lock) => {
        acquired = true;
        return lock;
      });

    await Promise.resolve();
    expect(acquired).toBe(false);

    await first.release();
    const successor = await waiting;
    expect(acquired).toBe(true);
    await successor.release();
  });
});

class FakeLockManager implements WebLockManagerLike {
  private readonly active = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: WebLockLike | null) => Promise<T> | T,
  ): Promise<T> {
    if (this.active.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(name) ?? [];
        queue.push(resolve);
        this.waiters.set(name, queue);
      });
    }
    this.active.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.active.delete(name);
      this.waiters.get(name)?.shift()?.();
    }
  }
}
