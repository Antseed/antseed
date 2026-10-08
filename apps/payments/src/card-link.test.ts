import { describe, expect, it } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import {
  antseedPayMessage,
  buildAntseedPayLink,
  DEFAULT_ANTSEED_PAY_URL,
  resolveCardProviderUrl,
  signAntseedPayUrl,
} from './card-link.js';

// Obvious fake key.
const WALLET = new Wallet(`0x${'11'.repeat(32)}`);

describe('card link', () => {
  it('signs the pay page wire format', () => {
    expect(antseedPayMessage('0xAbCdEf0000000000000000000000000000000001', '10.5'))
      .toBe('AntSeed Pay\naddress: 0xabcdef0000000000000000000000000000000001\ncurrency: USD\namount: 10.5');
  });

  it('builds a link whose signature recovers to the wallet', async () => {
    const url = new URL(await buildAntseedPayLink({ baseUrl: DEFAULT_ANTSEED_PAY_URL, wallet: WALLET, amount: '20', integration: 'stripe' }));
    expect(url.origin).toBe('https://antseed-pay.com');
    expect(url.searchParams.get('address')).toBe(WALLET.address);
    expect(url.searchParams.get('cur')).toBe('USD');
    expect(url.searchParams.get('amount')).toBe('20');
    expect(url.searchParams.get('provider')).toBe('stripe');
    expect(verifyMessage(antseedPayMessage(WALLET.address, '20'), url.searchParams.get('sig')!)).toBe(WALLET.address);
  });

  it('expands templates and drops amount placeholders when no amount is given', () => {
    expect(resolveCardProviderUrl('https://pay.example.test/?buyer={address}&amt={amount}', '0xabc', '5').toString())
      .toBe('https://pay.example.test/?buyer=0xabc&amt=5');
    expect(resolveCardProviderUrl('https://pay.example.test/?buyer={address}&amt={amount}', '0xabc', '').toString())
      .toBe('https://pay.example.test/?buyer=0xabc');
  });

  it('signs an empty amount without an amount param', async () => {
    const url = await signAntseedPayUrl(new URL('https://pay.example.test/'), { wallet: WALLET, amount: '', integration: 'crossmint' });
    expect(url.searchParams.has('amount')).toBe(false);
    expect(verifyMessage(antseedPayMessage(WALLET.address, ''), url.searchParams.get('sig')!)).toBe(WALLET.address);
  });

  it('allows loopback http and refuses other plain http or bad URLs', () => {
    expect(() => resolveCardProviderUrl('http://localhost:3120/', '0xabc', '1')).not.toThrow();
    expect(() => resolveCardProviderUrl('http://pay.example.test/', '0xabc', '1')).toThrow('Card provider URL must be https');
    expect(() => resolveCardProviderUrl('not a url', '0xabc', '1')).toThrow('Card provider URL is invalid');
  });
});
