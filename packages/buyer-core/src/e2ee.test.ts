import { describe, expect, it } from 'vitest';
import { SigningKey, computeAddress, getBytes } from 'ethers';
import {
  E2eeError,
  E2eeSseDecryptor,
  createE2eeNonce,
  createE2eeSession,
  decryptChatCompletionResponse,
  decryptE2eeText,
  e2eeRequestHeaders,
  encryptChatCompletionRequest,
  encryptE2eeText,
  isE2eeCiphertext,
  verifyUpstreamE2eeAttestation,
  type E2eeQuoteVerifier,
  type E2eeSession,
} from './e2ee.js';

/** Stands in for the upstream TEE: holds the model key and seals replies to the client key. */
const model = new SigningKey(`0x${'22'.repeat(32)}`);

async function sealToClient(session: E2eeSession, text: string): Promise<string> {
  return encryptE2eeText(text, session.clientKey.publicKey);
}

describe('venice-v1 ciphertext', () => {
  it('decrypts a ciphertext made by an independent implementation', async () => {
    // Produced by a Python reference (ecdsa + cryptography) for the model key above.
    const vector = '0494beeb5b6a5f368a9c3058dfc5058d96818a1579aa7baf7e05c052dc26fb364b9d97c67ee6ae8c317dfe348dcbdcbab9ec8fc6e1688db84f4ed5ce76bdd491447b0f7d7aace53607192b1b3d55f0aac0ed16071995eb9526e61689f2d0b1a4c11e95000d0dfb646cc0c19dadb8210b6af2d28a958421e2fbecf02b1a3e6b128b4856';
    expect(await decryptE2eeText(vector, model)).toBe('hello from python, codeword KESTREL-12');
  });

  it('round-trips and uses a fresh ephemeral key each time', async () => {
    const a = await encryptE2eeText('secret', model.publicKey);
    const b = await encryptE2eeText('secret', model.publicKey);
    expect(a).not.toBe(b);
    expect(isE2eeCiphertext(a)).toBe(true);
    expect(a).not.toContain(Buffer.from('secret').toString('hex'));
    expect(await decryptE2eeText(a, model)).toBe('secret');
  });

  it('rejects a tampered ciphertext', async () => {
    const sealed = await encryptE2eeText('secret', model.publicKey);
    const flipped = sealed.slice(0, -2) + (sealed.endsWith('00') ? '01' : '00');
    await expect(decryptE2eeText(flipped, model)).rejects.toBeInstanceOf(E2eeError);
  });
});

describe('encryptChatCompletionRequest', () => {
  it('encrypts every message and keeps the other fields', async () => {
    const session = createE2eeSession(model.publicKey);
    const out = await encryptChatCompletionRequest({
      model: 'qwen', stream: true, max_tokens: 10,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'codeword OSPREY' }] },
        { role: 'assistant', content: 'ok', name: 'bot' },
      ],
    }, session);
    expect(out).toMatchObject({ model: 'qwen', stream: true, max_tokens: 10 });
    const messages = out['messages'] as Array<Record<string, unknown>>;
    expect(messages.map((m) => m['role'])).toEqual(['system', 'user', 'assistant']);
    expect(JSON.stringify(out)).not.toMatch(/OSPREY|be brief|"bot"/);
    expect(await Promise.all(messages.map((m) => decryptE2eeText(m['content'] as string, model))))
      .toEqual(['be brief', 'codeword OSPREY', 'ok']);
  });

  it.each([
    ['tool definitions', { tools: [{ type: 'function' }] }],
    ['an image part', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }],
    ['a tool result', { messages: [{ role: 'tool', content: 'r', tool_call_id: '1' }] }],
    ['no messages', { messages: [] }],
  ])('fails closed on %s', async (_label, patch) => {
    const session = createE2eeSession(model.publicKey);
    await expect(encryptChatCompletionRequest({ messages: [{ role: 'user', content: 'hi' }], ...patch }, session))
      .rejects.toBeInstanceOf(E2eeError);
  });

  it('sends the client key the response is sealed to', () => {
    const session = createE2eeSession(model.publicKey);
    const headers = e2eeRequestHeaders(session);
    expect(headers['x-venice-tee-model-pub-key']).toBe(model.publicKey.slice(2));
    expect(headers['x-venice-tee-client-pub-key']).toBe(session.clientKey.publicKey.slice(2));
    expect(headers['x-venice-tee-signing-algo']).toBe('ecdsa');
  });
});

describe('response decryption', () => {
  it('decrypts a JSON response', async () => {
    const session = createE2eeSession(model.publicKey);
    const body = { choices: [{ message: { role: 'assistant', content: await sealToClient(session, 'hello') } }], usage: { total_tokens: 3 } };
    const out = await decryptChatCompletionResponse(body, session);
    expect(out).toMatchObject({ choices: [{ message: { content: 'hello' } }], usage: { total_tokens: 3 } });
  });

  it('decrypts an SSE stream split at arbitrary points', async () => {
    const session = createE2eeSession(model.publicKey);
    const events = [
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { content: await sealToClient(session, 'Hel') } }] },
      { choices: [{ delta: { content: await sealToClient(session, 'lo') } }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ];
    const raw = `${events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('')}data: [DONE]\r\n\r\n`;
    const decryptor = new E2eeSseDecryptor(session);
    let out = '';
    for (let i = 0; i < raw.length; i += 37) out += await decryptor.push(raw.slice(i, i + 37));
    out += await decryptor.flush();
    const text = out.split('\n').filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ delta?: { content?: string } }> })
      .map((e) => e.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(out).toContain('"usage":{"prompt_tokens":5,"completion_tokens":2}');
    expect(out).toContain('data: [DONE]\r\n\r\n');
    expect(decryptor.stats).toEqual({ encrypted: 2, plaintext: 0 });
  });
});

describe('verifyUpstreamE2eeAttestation', () => {
  const nonce = createE2eeNonce();
  const address = computeAddress(model.publicKey).toLowerCase();
  const reportData = new Uint8Array(64);
  reportData.set(getBytes(address), 0);
  reportData.set(getBytes(`0x${nonce}`), 32);
  const good: E2eeQuoteVerifier = async () => ({ status: 'UpToDate', acceptable: true, reportData, debug: false });
  const attestation = {
    nonce, signing_key: model.publicKey.slice(4), signing_address: address,
    intel_quote: Buffer.from('quote').toString('base64'), verified: false,
  };

  it('accepts a quote that binds the key and our nonce, ignoring the upstream verdict', async () => {
    const out = await verifyUpstreamE2eeAttestation(attestation, nonce, good);
    expect(out.modelPublicKey).toBe(model.publicKey.slice(2));
    expect(out.signingAddress).toBe(address);
  });

  it.each([
    ['another nonce', { nonce: createE2eeNonce() }, good],
    ['a key that is not the signing address', { signing_key: new SigningKey(`0x${'33'.repeat(32)}`).publicKey }, good],
    ['no quote', { intel_quote: '' }, good],
  ] as const)('rejects %s', async (_label, patch, verify) => {
    await expect(verifyUpstreamE2eeAttestation({ ...attestation, ...patch }, nonce, verify)).rejects.toBeInstanceOf(E2eeError);
  });

  it.each([
    ['a failed TCB', { status: 'Revoked', acceptable: false, reportData, debug: false }],
    ['a debug TD', { status: 'UpToDate', acceptable: true, reportData, debug: true }],
    ['report_data for another nonce', { status: 'UpToDate', acceptable: true, reportData: new Uint8Array(64), debug: false }],
  ])('rejects %s', async (_label, verdict) => {
    await expect(verifyUpstreamE2eeAttestation(attestation, nonce, async () => verdict)).rejects.toBeInstanceOf(E2eeError);
  });
});
