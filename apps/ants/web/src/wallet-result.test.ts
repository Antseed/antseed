import { describe, expect, it, vi } from 'vitest';
import { WalletResultDelivery } from './wallet-result';

describe('automatic wallet result delivery', () => {
  it.each([{ id: 'request-1', hash: '0xabc' }, { id: 'request-1', error: 'User rejected the request.' }])('retries the same result after a reporting failure: %j', async result => {
    const send = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
    const delivery = new WalletResultDelivery(send);
    delivery.enqueue(result);
    await delivery.deliver(result.id);
    await delivery.deliver(result.id);
    await delivery.deliver(result.id);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls).toEqual([[result], [result]]);
  });

  it('does not duplicate a result while acknowledgment is in flight', async () => {
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const delivery = new WalletResultDelivery(send);
    delivery.enqueue({ id: 'request-1', hash: '0xabc' });
    const first = delivery.deliver('request-1');
    await delivery.deliver('request-1');
    expect(send).toHaveBeenCalledOnce();
    finish();
    await first;
    await delivery.deliver('request-1');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not lose a broadcast hash to a stale poll or replace it with an error', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const delivery = new WalletResultDelivery(send);
    delivery.enqueue({ id: 'request-1', hash: '0xabc' });
    delivery.enqueue({ id: 'request-1', error: 'Cancelled' });
    await delivery.deliver(null);
    await delivery.deliver('request-2');
    expect(send).not.toHaveBeenCalled();
    await delivery.deliver('request-1');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ id: 'request-1', hash: '0xabc' });
  });
});
