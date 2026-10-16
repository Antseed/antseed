import { describe, expect, it } from 'vitest';
import { getAddress, Wallet, verifyMessage } from 'ethers';
import {
  ANTSEED_PAY_DEFAULT_AMOUNT,
  antseedPayAmount,
  antseedPayLinkAmount,
  antseedPayMessage,
  buildAntseedPayLink,
  DEFAULT_ANTSEED_PAY_URL,
  resolveCardProviderUrl,
  signAntseedPayUrl,
} from './card-link.js';

// Obvious fake key.
const WALLET = new Wallet(`0x${'11'.repeat(32)}`);

/**
 * The deployed antseed-pay.com link check, transcribed from its bundle
 * (`buildFundingMessage` / `parseLink`): the page refuses a link whose
 * amount is missing, has more than two decimals or is outside $1–$200
 * before it checks the signature, and recovers the signer from the same
 * header + lowercased address + currency + amount lines. Keep in step with
 * the page; a signer that drifts from it opens to "This funding link is
 * invalid or was altered".
 */
function payPageParseLink(link: string): { address: string; amount: string } {
  const params = new URL(link).searchParams;
  const address = getAddress(params.get('address') ?? '');
  const cur = params.get('cur') ?? '';
  const amount = params.get('amount') ?? '';
  const sig = params.get('sig') ?? '';
  if (!['USD', 'GBP', 'EUR'].includes(cur)) throw new Error('unsupported currency');
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('invalid amount format');
  if (Number(amount) < 1 || Number(amount) > 200) throw new Error('amount must be between 1 and 200');
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('invalid signature format');
  const message = ['AntSeed Pay', `address: ${address.toLowerCase()}`, `currency: ${cur}`, `amount: ${amount}`].join('\n');
  if (verifyMessage(message, sig).toLowerCase() !== address.toLowerCase()) throw new Error('signature does not match the address');
  return { address, amount };
}

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

  it('refuses to sign an amount the pay page would reject', async () => {
    for (const amount of ['', '0.5', '250', '10.123', '1e1', ' 10', 'abc']) {
      await expect(signAntseedPayUrl(new URL('https://pay.example.test/'), { wallet: WALLET, amount, integration: 'crossmint' }))
        .rejects.toThrow('Antseed Pay amount must be $1–$200 with at most 2 decimals');
    }
  });

  it('normalises amounts to what the pay page accepts', () => {
    expect(antseedPayAmount('10.50')).toBe('10.5');
    expect(antseedPayAmount(20)).toBe('20');
    expect(antseedPayAmount('1')).toBe('1');
    expect(antseedPayAmount('200')).toBe('200');
    expect(antseedPayAmount('199.99')).toBe('199.99');
    for (const bad of ['', '0', '0.99', '200.01', '10.125', 'abc', null, undefined, Number.NaN]) {
      expect(antseedPayAmount(bad)).toBeNull();
    }
    expect(antseedPayLinkAmount('')).toBe(ANTSEED_PAY_DEFAULT_AMOUNT);
    expect(antseedPayLinkAmount('25')).toBe('25');
    expect(antseedPayLinkAmount('0.5')).toBe(ANTSEED_PAY_DEFAULT_AMOUNT);
  });

  // Regression: the desktop's Add Credits chooser opens the page with no
  // amount entered, and the page refuses a link without one. Every link the
  // signer builds — with or without a user amount — must pass the page's
  // own check.
  it('builds links the deployed pay page accepts, with and without a user amount', async () => {
    for (const [input, expected] of [['', ANTSEED_PAY_DEFAULT_AMOUNT], ['5', '5'], ['10.50', '10.5'], ['200', '200']] as const) {
      const link = await buildAntseedPayLink({
        baseUrl: DEFAULT_ANTSEED_PAY_URL,
        wallet: WALLET,
        amount: antseedPayLinkAmount(input),
        integration: 'crossmint',
      });
      expect(payPageParseLink(link)).toEqual({ address: WALLET.address, amount: expected });
    }
  });

  it('is rejected by the pay page when the signed header or address casing drifts', async () => {
    const good = antseedPayMessage(WALLET.address, '20');
    const link = (sig: string): string => `${DEFAULT_ANTSEED_PAY_URL}?address=${WALLET.address}&cur=USD&amount=20&sig=${sig}`;
    expect(payPageParseLink(link(await WALLET.signMessage(good)))).toEqual({ address: WALLET.address, amount: '20' });
    // The copy rename that broke the link once (CHANGELOG: "Antseed Pay").
    const renamed = await WALLET.signMessage(good.replace('AntSeed Pay', 'Antseed Pay'));
    expect(() => payPageParseLink(link(renamed))).toThrow('signature does not match the address');
    const checksummed = await WALLET.signMessage(good.replace(WALLET.address.toLowerCase(), WALLET.address));
    expect(() => payPageParseLink(link(checksummed))).toThrow('signature does not match the address');
    // And a link with no amount at all is refused before the signature is read.
    const unsigned = `${DEFAULT_ANTSEED_PAY_URL}?address=${WALLET.address}&cur=USD&sig=${await WALLET.signMessage(antseedPayMessage(WALLET.address, ''))}`;
    expect(() => payPageParseLink(unsigned)).toThrow('invalid amount format');
  });

  it('allows loopback http and refuses other plain http or bad URLs', () => {
    expect(() => resolveCardProviderUrl('http://localhost:3120/', '0xabc', '1')).not.toThrow();
    expect(() => resolveCardProviderUrl('http://pay.example.test/', '0xabc', '1')).toThrow('Card provider URL must be https');
    expect(() => resolveCardProviderUrl('not a url', '0xabc', '1')).toThrow('Card provider URL is invalid');
  });
});
