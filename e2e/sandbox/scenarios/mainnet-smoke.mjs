export const meta = {
  description: 'Real network, real funds: the full desktop (its own buyer from this worktree) discovers live sellers, sends one chat, gets a reply, signs a nonzero amount within the per-run cap, and the on-chain deposit stays consistent.',
  targets: ['mainnet'],
  requires: ['realFunds', 'desktop'],
};

export async function run(sb) {
  const before = await sb.buyerBalance();
  sb.metric('depositAvailableBeforeMicroUsdc', String(before.available));
  sb.check('test wallet has a deposit to spend', before.available > 0n, String(before.available));

  const ui = await sb.desktop();
  await ui.screenshot('launched');

  const peers = await sb.waitForPeers({ min: 1 });
  sb.metric('peersDiscovered', peers.length);
  sb.check('the desktop buyer discovered live sellers', peers.length >= 1, peers.length);
  const models = await sb.models();
  sb.metric('networkModels', models.length);
  sb.check('the network catalog lists models', models.length >= 1, models.length);

  const snapshot = await sb.signedSnapshot();
  const prompt = `mainnet-smoke ${Date.now()}: reply with only the word PONG.`;
  const chat = await ui.sendChat(prompt, { expect: /PONG/i, timeoutMs: 120_000 });
  await ui.screenshot('reply');
  sb.check('the desktop shows a reply from a live seller', chat.reply.length > 0, chat.reply.slice(0, 200));
  sb.metric('desktopChatLatencyMs', chat.latencyMs);

  const spent = await sb.waitFor(async () => {
    const value = await sb.spentSince(snapshot);
    return value > 0n ? value : null;
  }, 'the chat to sign a SpendingAuth', { timeoutMs: 30_000 });
  sb.check('the chat signed a nonzero amount', spent > 0n, String(spent));
  await sb.assertWithinCap(snapshot);

  const after = await sb.buyerBalance();
  sb.metric('depositAvailableAfterMicroUsdc', String(after.available));
  sb.metric('depositReservedAfterMicroUsdc', String(after.reserved));
  sb.check('on-chain reserve grew by at most the cap', after.reserved <= before.reserved + sb.capMicros, `${before.reserved} -> ${after.reserved}`);
  sb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
}
