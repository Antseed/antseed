// #1463: money shown as held in sessions with no channel to close. The contract keeps a channel's reserve locked until
// the seller closes it or the buyer's operator withdraws, and a seller that is gone never closes. The buyer's store is
// no guide to that: it retires a row when it gives up on the session (a `channel_exhausted` answer writes `ghost`
// without reading the chain), which does not close the channel, and Activity only listed rows it still called active.
// A channel the buyer had signed in full was hidden as well, though withdraw() returns whatever the seller never settled.
//
// Two sellers crash with their channels open. The store is then edited while the buyer is stopped, the one step no
// public path reaches on demand: one row is retired an hour ago, as `retireSession(peer, GHOST)` retires it, and the
// other reads as signed up to its reserve. Activity must list both, the retired one with the on-chain close (it is not
// the live session, so its seller cannot close it), and that close must hand its channel to the wallet page. The page
// needs a wallet, so the exit itself runs through the CLI, and the reserves must come back after the grace period.
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const meta = {
  description: '#1463: a channel the buyer retired locally, or signed in full, but the chain still holds open stays reachable: the buyer reports the chain\'s record of it, Activity and `buyer activity` list it, Activity with a close action that hands it to the wallet page, the balance counts its signed spend, `buyer channels request-close` accepts it, and the reserve comes back after the grace.',
  targets: ['local'],
  requires: ['desktop', 'mockControl', 'sellerControl', 'buyerControl', 'warpTime'],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'retired' }, { id: 'spent' }],
};

/** AntseedChannels.TIMEOUT_GRACE_PERIOD. */
const GRACE_SECONDS = 15 * 60;
const SCREEN_WAIT_MS = 45_000;
const HOUR_MS = 60 * 60 * 1000;

/** micro-USDC as an Activity row prints it: dollars and whole cents, rounded down. */
const rowUsd = (micros) => `$${micros / 1_000_000n}.${String((micros % 1_000_000n) / 10_000n).padStart(2, '0')}`;
/** micro-USDC as the balance card prints it: rounded to the cent. */
const cardUsd = (micros) => `$${(Number(micros) / 1e6).toFixed(2)}`;
/** A decimal USDC string ("1.000036") as micro-USDC. */
const micros = (usdc) => {
  const [whole, fraction = ''] = String(usdc).split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
};
/** What a seller can still settle on a channel: what was signed less what it settled (both stay within the deposit here). */
const claimable = (signed, state) => (BigInt(signed) > BigInt(state.settled) ? BigInt(signed) - BigInt(state.settled) : 0n);
/** The desktop's pending-spend cache lives this long; a read after it comes from its own reader. */
const PENDING_SPEND_TTL_MS = 20_000;

function editStore(buyerDir, edit) {
  const Database = createRequire(new URL('../../../../packages/node/package.json', import.meta.url))('better-sqlite3');
  const db = new Database(join(buyerDir, 'payments', 'sessions.db'), { fileMustExist: true, timeout: 5000 });
  try {
    edit(db);
  } finally {
    db.close();
  }
}

/** The renderer refreshes channels and balances on focus, as it does when the user comes back from the pay page. */
const refresh = (ui) => ui.page.evaluate(() => window.dispatchEvent(new Event('focus')));

/** Every changed screen at both window presets, in both themes. */
async function screenshots(ui, name) {
  const resize = (width, height) => ui.app.evaluate(({ BrowserWindow }, size) => {
    const [window] = BrowserWindow.getAllWindows();
    window.setMinimumSize(480, 560);
    window.setSize(size.width, size.height);
  }, { width, height });
  for (const [preset, width, height] of [['standard', 1240, 860], ['compact', 512, 656]]) {
    await resize(width, height);
    await ui.page.waitForTimeout(600);
    for (const theme of ['light', 'dark']) {
      await ui.page.evaluate((dark) => document.body.classList.toggle('dark-theme', dark), theme === 'dark');
      await ui.page.waitForTimeout(200);
      await ui.screenshot(`${name}-${preset}-${theme}`);
    }
  }
  await resize(1240, 860);
  await ui.page.evaluate(() => document.body.classList.remove('dark-theme'));
}

export async function run(tb) {
  for (const seller of tb.sellers) await tb.chat({ model: seller.models[0], sellerId: seller.id, prompt: `paid chat with ${seller.id}` });
  const signed = await tb.waitFor(async () => {
    const rows = ((await tb.request('/_antseed/channels')).json?.channels ?? []).filter((row) => row.status === 'active' && BigInt(row.cumulativeSigned ?? '0') > 0n);
    return rows.length === tb.sellers.length ? rows : null;
  }, 'a signed, active channel with each seller', { timeoutMs: 30_000 });
  const rowOf = (id) => signed.find((row) => row.peerId === tb.seller(id).peerId);
  const retired = rowOf('retired');
  const spent = rowOf('spent');
  tb.check('each seller has its own channel', Boolean(retired && spent && retired.channelId !== spent.channelId), { signed: signed.map((row) => row.channelId) });

  try {
    await strandAndRecover(tb, retired, spent);
  } finally {
    // Reported, not thrown: an error here must not hide the failure that led here. Teardown fails on a locked reserve.
    await releaseReserves(tb, [retired, spent]).catch((error) => console.error(`[issue-1463] could not release the reserves: ${error.message}`));
  }
}

/**
 * A failed check must not leave a reserve locked: the sellers are gone, so teardown could not close their channels.
 * Each channel is tried on its own, and the reserve is checked at the end.
 */
async function releaseReserves(tb, channels) {
  const problems = [];
  const attempt = async (channelId, step) => {
    try {
      await step();
    } catch (error) {
      problems.push(`${channelId.slice(0, 18)}: ${error.message}`);
    }
  };
  const open = [];
  for (const { channelId } of channels) {
    await attempt(channelId, async () => {
      const state = await tb.channelState(channelId);
      if (state.status !== 1) return;
      if (state.closeRequestedAt === 0) await tb.buyerRequestClose(channelId);
      open.push(channelId);
    });
  }
  if (open.length > 0) {
    await tb.warp(GRACE_SECONDS + 60);
    for (const channelId of open) await attempt(channelId, () => tb.buyerWithdraw(channelId));
  }
  const { reserved } = await tb.buyerBalance();
  if (reserved !== 0n) problems.push(`the buyer still has ${reserved} reserved`);
  if (problems.length > 0) throw new Error(problems.join('; '));
}

async function strandAndRecover(tb, retired, spent) {
  // The sellers lose power, as a seller that no longer exists did: a graceful stop would settle and close the channels.
  for (const seller of tb.sellers) await tb.crashSeller(seller.id);
  const stranded = { retired: await tb.channelState(retired.channelId), spent: await tb.channelState(spent.channelId) };
  const held = (state) => BigInt(state.deposit) - BigInt(state.settled);
  const heldOnChain = held(stranded.retired) + held(stranded.spent);
  const start = await tb.buyerBalance();
  tb.check('both channels are open on-chain and hold the reserve', stranded.retired.status === 1 && stranded.spent.status === 1 && start.reserved === heldOnChain, { stranded, reserved: String(start.reserved), heldOnChain: String(heldOnChain) });

  await tb.stopBuyer();
  try {
    editStore(tb.manifest.buyerDir, (db) => {
      db.prepare('update payment_channels set status = ?, updated_at = ? where session_id = ?').run('ghost', Date.now() - HOUR_MS, retired.channelId);
      db.prepare('update payment_channels set auth_max = ? where session_id = ?').run(stranded.spent.deposit, spent.channelId);
    });
  } finally {
    await tb.startBuyer();
  }
  const listed = ((await tb.request('/_antseed/channels')).json?.channels ?? []).map((row) => row.channelId);
  tb.check('the buyer no longer calls the retired channel active', !listed.includes(retired.channelId) && listed.includes(spent.channelId), { listed });

  // The buyer reports the chain's record of every stored row, so the desktop, the gateway console and
  // `antseed buyer activity` show one answer without each joining the store with the chain.
  const view = await tb.waitFor(async () => {
    const body = (await tb.request('/_antseed/channels?all=1')).json;
    return body?.onChain?.unaccountedReserved != null ? body : null;
  }, 'the buyer to report the chain view of its channels', { timeoutMs: 30_000 }).catch(() => ({}));
  const reported = (channelId) => (view.channels ?? []).find((row) => row.channelId === channelId);
  tb.check('the buyer reports both channels open on-chain, the retired one under its retired status', reported(retired.channelId)?.status === 'ghost' && reported(retired.channelId)?.onChain?.status === 1 && reported(spent.channelId)?.onChain?.status === 1, { retired: reported(retired.channelId), spent: reported(spent.channelId) });
  tb.check('the buyer reports the whole reserve as held by channels it has a row for', view.onChain?.reserved === String(heldOnChain) && view.onChain?.heldByChannels === String(heldOnChain) && view.onChain?.unaccountedReserved === '0', view.onChain);
  const summary = await tb.cli(['buyer', 'activity', '--json']);
  const summaryRows = new Map((summary.json?.channels ?? []).map((row) => [row.channelId, row]));
  tb.check('buyer activity lists both channels as active, with what the chain holds for each', summary.code === 0
    && [retired, spent].every((channel) => summaryRows.get(channel.channelId)?.status === 'active')
    && summaryRows.get(retired.channelId)?.onChainReserveBaseUnits === String(held(stranded.retired))
    && summaryRows.get(spent.channelId)?.onChainReserveBaseUnits === String(held(stranded.spent))
    && summary.json?.unaccountedReservedBaseUnits === '0', { code: summary.code, stderr: summary.stderr.slice(-300), channels: summary.json?.channels, unaccounted: summary.json?.unaccountedReservedBaseUnits });

  const ui = await tb.desktop();
  const { page } = ui;
  const openProfile = () => page.getByRole('button', { name: 'Profile', exact: true }).click();
  await openProfile();
  await page.getByText('held in sessions').waitFor({ timeout: SCREEN_WAIT_MS });
  const profile = await ui.text();
  tb.check('the balance reports the reserve as held in sessions', profile.includes(`${cardUsd(heldOnChain)} held in sessions`), { expected: `${cardUsd(heldOnChain)} held in sessions`, shown: profile.match(/\$[\d.]+ held in sessions/)?.[0] ?? 'no held amount' });

  await page.getByRole('button', { name: 'Activity' }).first().click();
  // Each row carries one close action: the seller-assisted close for the buyer's live session with a seller the
  // buyer still lists, the on-chain close for any other.
  const closeActions = page.getByRole('button', { name: /^(Close channel|Request on-chain close)$/ });
  await tb.waitFor(async () => (await closeActions.count()) === tb.sellers.length, 'Activity to list both stranded channels', { timeoutMs: SCREEN_WAIT_MS, intervalMs: 500 }).catch(() => {});
  const shown = await closeActions.count();
  const activity = (await ui.text()).replace(/\s+/g, ' ');
  await screenshots(ui, 'activity');
  tb.check('Activity lists every channel the chain holds open, each with a close action', shown === tb.sellers.length, { shown, expected: tb.sellers.length, heldOnChain: String(heldOnChain), screen: activity.slice(0, 400) });
  const recoverable = BigInt(stranded.retired.deposit) - BigInt(retired.cumulativeSigned);
  // The retired row is not the live session, so the seller cannot close it: only the on-chain close can.
  tb.check('the retired channel shows what closing it recovers, with the on-chain close', activity.includes(`${rowUsd(recoverable)} locked Request on-chain close`), { expected: `${rowUsd(recoverable)} locked Request on-chain close` });
  tb.check('the fully signed channel shows what the chain still holds', activity.includes(`${rowUsd(held(stranded.spent))} unsettled`), { expected: `${rowUsd(held(stranded.spent))} unsettled` });
  // The header is the same money the balance calls held in sessions; each row says what closing it recovers.
  tb.check('the Activity header totals what the chain holds for the listed channels', activity.toLowerCase().includes(`active channels ${rowUsd(heldOnChain)} locked`), { expected: `Active channels ${rowUsd(heldOnChain)} locked`, screen: activity.slice(0, 400) });
  tb.check('Activity reports no reserve beyond the listed channels', !activity.includes('no record of'), { screen: activity.slice(0, 600) });

  const credits = (await page.evaluate(() => window.antseedDesktop.creditsGetInfo({ fresh: true }))).data;
  const pending = claimable(retired.cumulativeSigned, stranded.retired) + claimable(stranded.spent.deposit, stranded.spent);
  tb.check("Activity's read counts the signed spend on both channels as authorized", micros(credits.pendingUsdc) === pending, { pendingUsdc: credits.pendingUsdc, expectedMicros: String(pending) });

  // The desktop's own exit: the retired row's on-chain close hands its channel to the wallet page. That page opens in
  // the system browser, so the browser call is stubbed first; nothing is clicked unless the stub took.
  const stubbed = await ui.app.evaluate(({ shell }) => {
    globalThis.__issue1463Opened = [];
    shell.openExternal = async (url) => { globalThis.__issue1463Opened.push(url); };
    return String(shell.openExternal).includes('__issue1463Opened');
  });
  tb.check('the system browser is stubbed before the close is clicked', stubbed === true, { stubbed });
  await page.getByRole('button', { name: 'Request on-chain close' }).click();
  const opened = await tb.waitFor(async () => (await ui.app.evaluate(() => globalThis.__issue1463Opened))[0] ?? null, 'the on-chain close to open the wallet page', { timeoutMs: 15_000, intervalMs: 250 }).catch(() => null);
  const handoff = opened ? new URL(opened) : null;
  tb.check("the retired row's on-chain close hands that channel to the wallet page", handoff?.searchParams.get('action') === 'close-channel' && handoff?.searchParams.get('channel') === retired.channelId, { opened, channelId: retired.channelId });
  const served = opened ? await fetch(opened, { signal: AbortSignal.timeout(15_000) }).then((response) => response.status, (error) => error.message) : null;
  tb.check('the wallet page for that channel is served', served === 200, { served });

  // Pending spend from the balance's own reader, not the one Activity's refresh left in the cache: away from the views
  // that refresh channels, past the cache's lifetime, the first fresh read starts it and the next returns its answer.
  await ui.openChat();
  await page.waitForTimeout(PENDING_SPEND_TTL_MS + 5_000);
  await page.evaluate(() => window.antseedDesktop.creditsGetInfo({ fresh: true }));
  await page.waitForTimeout(3_000);
  const cold = (await page.evaluate(() => window.antseedDesktop.creditsGetInfo({ fresh: true }))).data;
  tb.check("the balance's own read counts the signed spend on both channels as authorized", micros(cold.pendingUsdc) === pending, { pendingUsdc: cold.pendingUsdc, expectedMicros: String(pending) });

  // Profile counts the same channels, once its summary has loaded.
  await openProfile();
  const counted = `Payment channels ${tb.sellers.length} active`;
  await tb.waitFor(async () => (await ui.text()).replace(/\s+/g, ' ').includes(counted), 'Profile to count both channels', { timeoutMs: SCREEN_WAIT_MS, intervalMs: 500 }).catch(() => {});
  const profileCount = (await ui.text()).replace(/\s+/g, ' ');
  await screenshots(ui, 'profile');
  tb.check('Profile counts every channel the chain holds open as active', profileCount.includes(counted), { expected: counted, shown: profileCount.match(/Payment channels \d+ active/)?.[0] ?? 'no channel count' });
  await page.getByRole('button', { name: 'Activity' }).first().click();

  // The exit itself runs through the CLI: the wallet page needs a browser wallet.
  for (const channel of [retired, spent]) {
    const requested = await tb.cli(['buyer', 'channels', 'request-close', channel.channelId, '--json']);
    tb.check(`buyer channels request-close accepts ${channel === retired ? 'the retired' : 'the fully signed'} channel`, requested.code === 0 && requested.json?.channelId === channel.channelId, { code: requested.code, stderr: requested.stderr.slice(-300), stdout: requested.stdout.slice(-300) });
  }
  await refresh(ui);
  const closing = page.getByText('closing', { exact: true });
  await tb.waitFor(async () => (await closing.count()) === tb.sellers.length, 'Activity to show both channels closing', { timeoutMs: SCREEN_WAIT_MS, intervalMs: 500 }).catch(() => {});
  await screenshots(ui, 'activity-closing');
  tb.check('Activity shows both channels closing during the grace period', (await closing.count()) === tb.sellers.length, { closing: await closing.count() });

  await tb.warp(GRACE_SECONDS + 60);
  for (const channel of [retired, spent]) {
    const released = await tb.cli(['buyer', 'channels', 'withdraw', channel.channelId, '--json'], { clock: 'chain' });
    tb.check('buyer channels withdraw exits 0 after the grace', released.code === 0, { code: released.code, stderr: released.stderr.slice(-300) });
    tb.check('the channel timed out on-chain', (await tb.channelState(channel.channelId)).status === 3, await tb.channelState(channel.channelId));
  }
  const end = await tb.buyerBalance();
  tb.check('the whole reserve came back to the deposit', end.reserved === 0n && end.available === start.available + heldOnChain, { before: { available: String(start.available), reserved: String(start.reserved) }, after: { available: String(end.available), reserved: String(end.reserved) } });

  await refresh(ui);
  const empty = page.getByText('No open channels');
  await empty.waitFor({ timeout: SCREEN_WAIT_MS }).catch(() => {});
  tb.check('Activity is empty once the chain shows both channels ended', await empty.isVisible(), (await ui.text()).replace(/\s+/g, ' ').slice(0, 400));
  await screenshots(ui, 'activity-recovered');
  tb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
  await ui.close();
  tb.metric('recovered', { heldOnChain: String(heldOnChain), retired: retired.channelId, spent: spent.channelId });
}
