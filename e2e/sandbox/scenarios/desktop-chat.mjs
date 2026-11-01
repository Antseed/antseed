export const meta = {
  description: 'Attach-only desktop under Playwright: send a chat from the UI, see the sandbox reply, and settle exactly what the desktop chat signed.',
  targets: ['fork', 'local'],
  requires: ['desktop', 'mockControl'],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

export async function run(sb) {
  const [seller] = sb.sellers;
  const ui = await sb.desktop();
  await ui.screenshot('launched');

  const status = await ui.text();
  sb.check('desktop is attached to the sandbox proxy', status.includes(`Port: ${new URL(sb.proxyUrl).port}`), status.match(/Port: \d+/)?.[0] ?? 'no port shown');

  const prompt = `desktop-chat ${Date.now()}`;
  const chat = await ui.sendChat(prompt);
  await ui.screenshot('reply');
  sb.check('desktop shows the sandbox seller reply', chat.reply.includes(`seller ${seller.id}`), chat.reply);
  sb.metric('desktopChatLatencyMs', chat.latencyMs);

  const upstream = (await sb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions');
  sb.check('the desktop chat reached the sandbox seller upstream', upstream.length >= 1, upstream.length);
  sb.metric('upstreamChatRequests', upstream.length);

  const channel = ((await sb.channels())[seller.id] ?? [])[0];
  sb.check('buyer opened a channel for the desktop chat', Boolean(channel), channel ?? 'no channel');
  sb.check('desktop chat signed a nonzero cumulative amount', BigInt(channel.cumulativeSigned) > 0n, channel.cumulativeSigned);
  sb.metric('signedMicroUsdc', channel.cumulativeSigned);

  sb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
  await ui.close();

  await sb.closeAll();
  const settlement = await sb.assertSettlementMatchesSigned();
  sb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
}
