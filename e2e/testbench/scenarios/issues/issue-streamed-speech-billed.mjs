export const meta = {
  description: 'A speech request priced per character is served and paid whether it asks for the audio itself or for the audio as a stream of events (`stream_format: "sse"`); a run of streamed speech worth more than the buyer\'s overdraft window is served and paid in full; what was signed is settled exactly.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

const SPEECH_MODEL = 'gpt-4o-mini-tts';
const CHARACTER_PRICE_USD = 0.0001;
// 1000 characters: 0.10 USDC a request.
const INPUT = 'The quick brown fox jumps over the lazy dog. '.repeat(23).slice(0, 1000);
const SPEECH_PRICE = BigInt(Math.round(CHARACTER_PRICE_USD * INPUT.length * 1_000_000));
// The CLI buyer's default overdraft window: how much it signs beyond what it has verified.
const MAX_PER_REQUEST_USDC = '0.3';
// Streamed answers in a row, worth more than one overdraft window (5 x 0.10 > 0.30), so a buyer that could not
// count them would run out of window and be refused partway through.
const RUN = 5;

// cli mode, so `--seller-tree` and `--buyer-tree` can run either side from another checkout.
export const topology = {
  mode: 'cli',
  sellers: [{
    id: 'seller',
    providers: {
      mock: {
        plugin: 'openai',
        services: {
          [SPEECH_MODEL]: {
            capabilities: { inputs: ['text'], outputs: ['audio'] },
            unitBillingModels: { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd: CHARACTER_PRICE_USD }] } },
          },
        },
      },
    },
  }],
  buyer: { maxPerRequestUsdc: MAX_PER_REQUEST_USDC, maxPricing: { defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } } },
};

/** The audio of an answer streamed as OpenAI's speech events: the decoded deltas, and whether a done event ended them. */
function streamedAudio(text) {
  const events = [...text.matchAll(/^data: (.+)$/gm)].map((match) => { try { return JSON.parse(match[1]); } catch { return null; } });
  const deltas = events.filter((data) => data?.type === 'speech.audio.delta' && typeof data.audio === 'string');
  const bytes = Buffer.concat(deltas.map((data) => Buffer.from(data.audio, 'base64')));
  return { deltas: deltas.length, bytes: bytes.length, mp3: bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0, done: events.at(-1)?.type === 'speech.audio.done' };
}

export async function run(tb) {
  const [seller] = tb.sellers;
  const upstreamSpeech = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/audio/speech');
  const channel = async () => ((await tb.channels())[seller.id] ?? [])[0];
  // Every channel, closed ones too: a buyer that runs out of overdraft window retires its channel and opens another.
  const channelCount = async () => ((await tb.channels({ all: true }))[seller.id] ?? []).length;
  const signed = async () => (await tb.signedBySeller())[seller.id] ?? 0n;
  const speak = (extra = {}) => tb.request('/v1/audio/speech', { stream: extra.stream_format === 'sse', body: { model: SPEECH_MODEL, input: INPUT, voice: 'alloy', ...extra } });

  const fresh = { speech: (await upstreamSpeech()).length, channel: await channel() };
  tb.check('scenario starts on a fresh testbench (no speech requests, no open channel)', fresh.speech === 0 && !fresh.channel, fresh);

  // Speech answered as the audio itself, which per-character billing already counted.
  const plain = await speak();
  await tb.waitForPaidChannels(seller.id, { requests: 1, signed: SPEECH_PRICE, timeoutMs: 15_000 });
  const signedAfterPlain = await signed();
  tb.check('the speech answered as audio was served and charged its characters', plain.status === 200 && /audio\/mpeg/.test(plain.headers['content-type'] ?? '') && signedAfterPlain === SPEECH_PRICE,
    { status: plain.status, contentType: plain.headers['content-type'] ?? null, signed: String(signedAfterPlain), price: String(SPEECH_PRICE), body: plain.status === 200 ? undefined : plain.text.slice(0, 300) });

  // The same request asking for OpenAI's stream of events.
  const servedBefore = (await upstreamSpeech()).length;
  const streamed = await speak({ stream_format: 'sse' });
  // Give any payment for it the same time the first one had.
  await tb.waitForPaidChannels(seller.id, { requests: 2, signed: signedAfterPlain + SPEECH_PRICE, timeoutMs: 15_000 });
  const signedForStreamed = (await signed()) - signedAfterPlain;
  const audio = streamedAudio(streamed.text);
  const observed = {
    status: streamed.status,
    contentType: streamed.headers['content-type'] ?? null,
    upstreamCalls: (await upstreamSpeech()).length - servedBefore,
    audio,
    signedForIt: String(signedForStreamed),
    price: String(SPEECH_PRICE),
    body: streamed.status === 200 ? undefined : streamed.text.slice(0, 300),
  };
  // One check first, so a failure shows the whole case at once.
  tb.check('the speech streamed as events was served and paid for', observed.upstreamCalls === 1 && streamed.status === 200 && signedForStreamed === SPEECH_PRICE, observed);
  tb.check('it arrived as a stream of audio deltas ended by the done event', /text\/event-stream/.test(observed.contentType ?? '') && audio.deltas > 1 && audio.mp3 && audio.done, observed);

  // A run of streamed speech, one after another, worth more than the buyer's overdraft window.
  const signedBeforeRun = await signed();
  const servedBeforeRun = (await upstreamSpeech()).length;
  const answers = [];
  for (let index = 0; index < RUN; index += 1) {
    const answer = await speak({ stream_format: 'sse' });
    answers.push({ status: answer.status, ...streamedAudio(answer.text), ...(answer.status === 200 ? {} : { body: answer.text.slice(0, 200) }) });
  }
  await tb.waitForPaidChannels(seller.id, { requests: 2 + RUN, signed: signedBeforeRun + BigInt(RUN) * SPEECH_PRICE, timeoutMs: 20_000 });
  const signedForRun = (await signed()) - signedBeforeRun;
  const runObserved = {
    statuses: answers.map((answer) => answer.status),
    upstreamCalls: (await upstreamSpeech()).length - servedBeforeRun,
    signedForRun: String(signedForRun),
    owed: String(BigInt(RUN) * SPEECH_PRICE),
    window: MAX_PER_REQUEST_USDC,
    channels: await channelCount(),
    refused: answers.filter((answer) => answer.status !== 200),
  };
  tb.check(`all ${RUN} streamed speech answers in a row were served, each with its audio`, answers.every((answer) => answer.status === 200 && answer.mp3 && answer.done) && runObserved.upstreamCalls === RUN, runObserved);
  // On the one channel: a buyer that could not count them would run out of window, retire it and open another.
  tb.check(`all ${RUN} were paid for exactly on the one channel, beyond one overdraft window`, signedForRun === BigInt(RUN) * SPEECH_PRICE && runObserved.channels === 1, runObserved);

  await tb.closeAll();
  const expected = await tb.signedBySeller();
  const settlement = await tb.assertSettlementMatchesSigned(expected);
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  const charged = signedAfterPlain + signedForStreamed + signedForRun;
  tb.check('settled amount equals what every speech answer was charged', BigInt(settlement.totalPaidMicroUsdc) === charged, { settled: settlement.totalPaidMicroUsdc, expected: String(charged) });
}
