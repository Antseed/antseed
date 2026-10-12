import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCheckoutAuthorizationMessage,
  createPeerPayCheckout,
} from './peer-pay.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const SIGNATURE = `0x${'11'.repeat(65)}`;
const TIMESTAMP_MS = 1_787_000_000_000;
const NONCE = '12345678-1234-4234-9234-123456789abc';
const INPUT = {
  endpoint: 'https://antseed-checkout.pay.zkp2p.xyz/api/checkout',
  address: ADDRESS,
  amount: '25',
};
const SIGNER = {
  signMessage: async () => SIGNATURE,
};

function dependencies(fetcher: typeof fetch) {
  return {
    fetcher,
    now: () => TIMESTAMP_MS,
    createNonce: () => NONCE,
  };
}

describe('Peer Pay checkout', () => {
  it('signs the exact checkout fields without exposing a merchant key', async () => {
    let signedMessage: string | undefined;
    let request: { url: string; init?: RequestInit } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        checkoutUrl: 'https://pay.peer.xyz/?order=order_123&token=order_token',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const signer = {
      signMessage: async (message: string) => {
        signedMessage = message;
        return SIGNATURE;
      },
    };

    const checkoutUrl = await createPeerPayCheckout(INPUT, signer, dependencies(fetcher));

    assert.equal(checkoutUrl, 'https://pay.peer.xyz/?order=order_123&token=order_token');
    assert.equal(request?.url, INPUT.endpoint);
    assert.equal(request?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      address: ADDRESS,
      amount: '25',
      timestamp: '1787000000',
      nonce: NONCE,
      signature: SIGNATURE,
    });
    assert.equal(signedMessage, buildCheckoutAuthorizationMessage({
      address: ADDRESS,
      amount: '25',
      timestamp: '1787000000',
      nonce: NONCE,
    }));
    assert.equal((request?.init?.headers as Record<string, string>)['X-API-Key'], undefined);
  });

  it('returns the server error without opening a checkout', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      error: {
        code: 'SERVICE_NOT_CONFIGURED',
        message: 'Checkout service is not configured',
      },
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      createPeerPayCheckout(INPUT, SIGNER, dependencies(fetcher)),
      /Checkout service is not configured/,
    );
  });

  it('rejects an insecure API endpoint before signing or sending the request', async () => {
    let signed = false;
    let fetched = false;

    await assert.rejects(
      createPeerPayCheckout({
        ...INPUT,
        endpoint: 'http://antseed-checkout.pay.zkp2p.xyz/api/checkout',
      }, {
        signMessage: async () => {
          signed = true;
          return SIGNATURE;
        },
      }, dependencies(async () => {
        fetched = true;
        return new Response();
      })),
      /Peer Pay endpoint URL must be https/,
    );
    assert.equal(signed, false);
    assert.equal(fetched, false);
  });

  it('rejects invalid amounts before signing or sending the request', async () => {
    for (const amount of ['1.0000001', 25 as unknown as string]) {
      let signed = false;
      let fetched = false;

      await assert.rejects(
        createPeerPayCheckout({ ...INPUT, amount }, {
          signMessage: async () => {
            signed = true;
            return SIGNATURE;
          },
        }, dependencies(async () => {
          fetched = true;
          return new Response();
        })),
        /positive USDC amount/,
      );
      assert.equal(signed, false);
      assert.equal(fetched, false);
    }
  });

  it('rejects an insecure checkout URL', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      checkoutUrl: 'http://pay.peer.xyz/?order=order_123&token=order_token',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      createPeerPayCheckout(INPUT, SIGNER, dependencies(fetcher)),
      /Peer Pay checkout URL must be https/,
    );
  });
});
