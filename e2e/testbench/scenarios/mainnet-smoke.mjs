import { MAX_PAID_CANDIDATES, tryPaidCandidates } from '../lib/mainnet-run.mjs';

export const meta = {
  description: 'Real network, real funds: the full desktop (its own buyer from this worktree) discovers live sellers, sends one chat, gets a reply, signs a nonzero amount within the per-run cap, and the on-chain deposit stays consistent.',
  targets: ['mainnet'],
  requires: ['realFunds', 'desktop'],
};

/** One try at one paid model, in a new chat through the desktop UI. A routing error on screen throws (see tryPaidCandidates). */
export async function chatOnPaidModel(tb, ui, { model }) {
  const search = [...new Set([model.name, model.id, ...model.peers.map((peer) => peer.serviceId)])];
  const selected = await ui.selectModel({ search, label: model.name }).catch((error) => ({ error: error.message }));
  await ui.screenshot(`selected-${model.id}`);
  tb.check(`the desktop selected the paid model ${model.id}`, !selected.error && selected.headerLabel === selected.rowTitle && !/\bfree\b/i.test(selected.headerLabel), selected);
  const chat = await ui.sendChat(`mainnet-smoke ${Date.now()}: reply with only the word PONG.`, { expect: /PONG/i, timeoutMs: 120_000 });
  // The desktop falls back to another model when the selected one has no route: the reply must be the selected model's.
  const after = await ui.modelPickerLabel();
  tb.check(`the chat ran on the selected model ${model.id}`, after === selected.rowTitle, { selected: selected.rowTitle, header: after });
  return chat;
}

export async function run(tb) {
  const before = await tb.buyerBalance();
  tb.metric('depositAvailableBeforeMicroUsdc', String(before.available));
  tb.check('test wallet has a deposit to spend', before.available > 0n, String(before.available));

  const ui = await tb.desktop();
  await ui.screenshot('launched');

  const peers = await tb.waitForPeers({ min: 1 });
  tb.metric('peersDiscovered', peers.length);
  tb.check('the desktop buyer discovered live sellers', peers.length >= 1, peers.length);
  const models = await tb.models();
  tb.metric('networkModels', models.length);
  tb.check('the network catalog lists models', models.length >= 1, models.length);

  // A fresh profile defaults to a free model, whose chat signs nothing: the paid path needs a paid model picked here.
  const { candidates, reason } = await tb.paidChatModels();
  tb.check('the live catalog has a paid chat model the buyer can route to', candidates.length > 0, candidates.length ? candidates.slice(0, MAX_PAID_CANDIDATES).map(({ model }) => model.id) : reason);

  const snapshot = await tb.signedSnapshot();
  const outcome = await tryPaidCandidates(candidates, (candidate) => chatOnPaidModel(tb, ui, candidate), { onAttempt: (entry) => tb.event('paid-model-attempt', entry) });
  tb.metric('paidModelAttempts', outcome.attempts);
  tb.check('a paid model answered the chat', Boolean(outcome.candidate), outcome.attempts);
  tb.metric('paidModel', outcome.candidate.model.id);
  tb.metric('paidModelInputUsdPerMillion', outcome.candidate.inputUsdPerMillion);
  tb.metric('paidModelOutputUsdPerMillion', outcome.candidate.outputUsdPerMillion);
  tb.metric('paidModelSellers', outcome.candidate.sellers);
  const chat = outcome.result;
  await ui.screenshot('reply');
  tb.check('the desktop shows a reply from a live seller', chat.reply.length > 0, chat.reply.slice(0, 200));
  tb.metric('desktopChatLatencyMs', chat.latencyMs);

  const spent = await tb.waitFor(async () => {
    const value = await tb.spentSince(snapshot);
    return value > 0n ? value : null;
  }, 'the chat to sign a SpendingAuth', { timeoutMs: 30_000 });
  tb.check('the chat signed a nonzero amount', spent > 0n, String(spent));
  await tb.assertWithinCap(snapshot);

  const after = await tb.buyerBalance();
  tb.metric('depositAvailableAfterMicroUsdc', String(after.available));
  tb.metric('depositReservedAfterMicroUsdc', String(after.reserved));
  tb.check('on-chain reserve grew by at most the cap', after.reserved <= before.reserved + tb.capMicros, `${before.reserved} -> ${after.reserved}`);
  tb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
}
