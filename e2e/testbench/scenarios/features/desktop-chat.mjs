export const meta = {
  description: 'Attach-only desktop under Playwright: send a chat from the UI, see the testbench reply, and settle exactly what the desktop chat signed.',
  targets: ['fork', 'local'],
  requires: ['desktop', 'mockControl'],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

export async function run(tb) {
  const [seller] = tb.sellers;
  const ui = await tb.desktop();
  await ui.screenshot('launched');

  const status = await ui.text();
  tb.check('desktop is attached to the testbench proxy', status.includes(`Port: ${new URL(tb.proxyUrl).port}`), status.match(/Port: \d+/)?.[0] ?? 'no port shown');

  const prompt = `desktop-chat ${Date.now()}`;
  const chat = await ui.sendChat(prompt);
  await ui.screenshot('reply');
  tb.check('desktop shows the testbench seller reply', chat.reply.includes(`seller ${seller.id}`), chat.reply);
  tb.metric('desktopChatLatencyMs', chat.latencyMs);

  const upstream = (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions');
  tb.check('the desktop chat reached the testbench seller upstream', upstream.length >= 1, upstream.length);
  tb.metric('upstreamChatRequests', upstream.length);

  // The desktop chat's SpendingAuth is stored after the reply reaches the UI; wait for it before judging the channel.
  const channel = (await tb.waitForPaidChannels(seller.id, { requests: 1 }))[0];
  tb.check('buyer opened a channel for the desktop chat', Boolean(channel), channel ?? 'no channel');
  tb.check('desktop chat signed a nonzero cumulative amount', BigInt(channel.cumulativeSigned) > 0n, channel.cumulativeSigned);
  tb.metric('signedMicroUsdc', channel.cumulativeSigned);

  tb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
  await ui.close();

  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned();
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
}
