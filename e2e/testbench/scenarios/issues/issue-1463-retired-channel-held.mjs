// #1463: money shown as held in sessions with no channel to close. The contract keeps a channel's reserve locked until
// the seller closes it or the buyer's operator withdraws, and a seller that is gone never closes. The buyer's store is
// no guide to that: it retires a row when it gives up on the session (a `channel_exhausted` answer writes `ghost`
// without reading the chain), which does not close the channel. Channels live in the gateway console; the desktop
// shows the reserve as held in sessions and links there.
//
// Two sellers crash with their channels open. The store is then edited while the buyer is stopped, the one step no
// public path reaches on demand: one row is retired an hour ago, as `retireSession(peer, GHOST)` retires it, and the
// other reads as signed up to its reserve. The buyer must report both open from the chain, and the console must list
// both with what each holds. The desktop's "held in sessions" must open those channels. The console's close needs a
// browser wallet, so the exit itself runs through the CLI, and the reserves must come back after the grace period.
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const meta = {
  description: '#1463: a channel the buyer retired, or signed in full, while the chain still holds it open, stays reachable: the buyer reports the chain\'s record of it, `buyer activity` and the gateway console list it with what it holds, the key balance counts its signed spend, the desktop\'s "held in sessions" opens the console\'s channels, `buyer channels request-close` accepts it, and the reserve comes back after the grace.',
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
/** Open on-chain statuses as the console reports them. */
const OPEN = new Set(['active', 'open', 'closing', 'withdrawable']);

/** micro-USDC as the balance card prints it: rounded to the cent. */
const cardUsd = (micros) => `$${(Number(micros) / 1e6).toFixed(2)}`;
/** micro-USDC as the console API reports it ("4.690000"). */
const usdc = (micros) => `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
/** A decimal USDC string ("1.000036") as micro-USDC. */
const micros = (value) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
};
/** What the chain holds for a channel: deposit less what the seller settled. */
const held = (state) => BigInt(state.deposit) - BigInt(state.settled);
/** What a seller can still settle on a channel: what was signed less what it settled (both stay within the deposit here). */
const claimable = (signed, state) => (BigInt(signed) > BigInt(state.settled) ? BigInt(signed) - BigInt(state.settled) : 0n);

function editStore(buyerDir, edit) {
  const Database = createRequire(new URL('../../../../packages/node/package.json', import.meta.url))('better-sqlite3');
  const db = new Database(join(buyerDir, 'payments', 'sessions.db'), { fileMustExist: true, timeout: 5000 });
  try {
    edit(db);
  } finally {
    db.close();
  }
}

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

/** The console API of a console gateway on the testbench buyer, read with a read-only management token. */
async function consoleApi(tb) {
  const gateway = await tb.gateway({ console: true });
  const created = await tb.cli(['gateway', 'admin-token', 'create', '--label', 'issue-1463', '--scope', 'read', '--expires-in-days', '1', '--json']);
  tb.check('a read-only management token for the console API', created.code === 0 && typeof created.json?.token === 'string', { code: created.code, stderr: created.stderr.slice(-300) });
  const get = async (path) => {
    const response = await fetch(`${gateway.url}/console/api${path}`, { headers: { authorization: `Bearer ${created.json.token}` }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`GET /console/api${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const workspaces = await get('/workspaces');
  const workspace = workspaces.find((entry) => entry.isDefault) ?? workspaces.find((entry) => entry.buyerIdentity === 'default');
  tb.check('the console has the default workspace on this buyer', Boolean(workspace), { workspaces: workspaces.map((entry) => [entry.id, entry.buyerIdentity]) });
  return {
    channels: ({ all = false, fresh = false } = {}) => get(`/workspaces/${workspace.id}/channels?${all ? 'all=1&' : ''}${fresh ? 'fresh=1' : ''}`),
    wallet: () => get(`/workspaces/${workspace.id}/wallet`),
  };
}

export async function run(tb) {
  for (const seller of tb.sellers) await tb.chat({ model: seller.models[0], sellerId: seller.id, prompt: `paid chat with ${seller.id}` });
  const signed = await tb.waitFor(async () => {
    const rows = ((await tb.request('/_antseed/channels')).json?.channels ?? []).filter((row) => row.status === 'active' && BigInt(row.cumulativeSigned ?? '0') > 0n);
    return rows.length === tb.sellers.length ? rows : null;
  }, 'a signed, active channel with each seller', { timeoutMs: 30_000 });
  const rowOf = (id) => signed.find((row) => row.peerId === tb.seller(id).peerId);
  const channels = { retired: rowOf('retired'), spent: rowOf('spent') };
  const ids = new Set(Object.values(channels).map((row) => row?.channelId));
  tb.check('each seller has its own channel', ids.size === 2 && !ids.has(undefined), { signed: signed.map((row) => row.channelId) });

  try {
    await strandAndRecover(tb, channels);
  } finally {
    // Reported, not thrown: an error here must not hide the failure that led here. Teardown fails on a locked reserve.
    await releaseReserves(tb, Object.values(channels)).catch((error) => console.error(`[issue-1463] could not release the reserves: ${error.message}`));
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

async function strandAndRecover(tb, { retired, spent }) {
  // The sellers lose power, as a seller that no longer exists did: a graceful stop would settle and close the channels.
  for (const seller of tb.sellers) await tb.crashSeller(seller.id);
  const stranded = { retired: await tb.channelState(retired.channelId), spent: await tb.channelState(spent.channelId) };
  const heldOnChain = held(stranded.retired) + held(stranded.spent);
  const start = await tb.buyerBalance();
  tb.check('both channels are open on-chain and hold the reserve', Object.values(stranded).every((state) => state.status === 1) && start.reserved === heldOnChain, { stranded, reserved: String(start.reserved), heldOnChain: String(heldOnChain) });

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
  tb.check('the buyer no longer calls the retired channel active', listed.includes(spent.channelId) && !listed.includes(retired.channelId), { listed });

  // The buyer keeps the chain's record of every stored row in its channel store and reports it with the row, so
  // the gateway console and `antseed buyer activity` show one answer. It reads the chain at start, and every 30 s.
  const view = await tb.waitFor(async () => {
    const body = (await tb.request('/_antseed/channels?all=1')).json;
    return body?.onChain?.stale === false && body.onChain.unaccountedReserved != null ? body : null;
  }, 'the buyer to record the chain state of its channels', { timeoutMs: 60_000 }).catch(() => ({}));
  const reported = (channelId) => (view.channels ?? []).find((row) => row.channelId === channelId);
  tb.check('the buyer records both channels open on-chain, the retired one under its retired status', reported(retired.channelId)?.status === 'ghost' && reported(retired.channelId)?.onChain?.status === 1 && reported(spent.channelId)?.onChain?.status === 1, { retired: reported(retired.channelId), spent: reported(spent.channelId) });
  tb.check('the buyer accounts for the whole reserve with the channels it has a row for', view.onChain?.heldByChannels === String(heldOnChain) && view.onChain?.unaccountedReserved === '0', view.onChain);

  const summary = await tb.cli(['buyer', 'activity', '--json']);
  const summaryRows = new Map((summary.json?.channels ?? []).map((row) => [row.channelId, row]));
  tb.check('buyer activity lists both as active, with what the chain holds for each', summary.code === 0
    && [retired, spent].every((channel) => summaryRows.get(channel.channelId)?.status === 'active')
    && summaryRows.get(retired.channelId)?.onChainReserveBaseUnits === String(held(stranded.retired))
    && summaryRows.get(spent.channelId)?.onChainReserveBaseUnits === String(held(stranded.spent))
    && summary.json?.unaccountedReservedBaseUnits === '0', { code: summary.code, stderr: summary.stderr.slice(-300), channels: summary.json?.channels, unaccounted: summary.json?.unaccountedReservedBaseUnits });

  // The gateway console: every channel the chain holds open, with what it holds and what closing it returns.
  const console_ = await consoleApi(tb);
  const listedInConsole = await console_.channels();
  const row = (channelId) => listedInConsole.find((entry) => entry.channelId === channelId);
  tb.check('the console lists both channels as open', [retired, spent].every((channel) => OPEN.has(row(channel.channelId)?.status)), { rows: listedInConsole.map((entry) => [entry.channelId, entry.status]) });
  tb.check('each console row says what the chain holds for it', row(retired.channelId)?.held === usdc(held(stranded.retired)) && row(spent.channelId)?.held === usdc(held(stranded.spent)), listedInConsole);
  tb.check('the fully signed channel holds its amount unsettled, not $0 to return', row(spent.channelId)?.unsettled === usdc(held(stranded.spent)), row(spent.channelId));
  tb.check('the retired channel offers only the on-chain close', row(retired.channelId)?.canCooperativeClose === false && row(retired.channelId)?.unsettled === usdc(claimable(retired.cumulativeSigned, stranded.retired)), row(retired.channelId));
  const wallet = await console_.wallet();
  const pending = claimable(retired.cumulativeSigned, stranded.retired) + claimable(stranded.spent.deposit, stranded.spent);
  tb.check('the console wallet reports the buyer\'s figures and no reserve beyond the listed channels', wallet.unaccounted === '0.000000' && wallet.heldInChannels === usdc(heldOnChain) && wallet.pending === usdc(pending) && wallet.channelsStale === false, { unaccounted: wallet.unaccounted, held: wallet.heldInChannels, pending: wallet.pending, stale: wallet.channelsStale });

  // The desktop: its balance (the gateway's `/v1/key`) counts the signed spend on the stored channels.
  const ui = await tb.desktop();
  const { page } = ui;
  const credits = (await page.evaluate(() => window.antseedDesktop.creditsGetInfo({ fresh: true }))).data;
  tb.check('the balance counts the signed spend on the retired and fully signed channels as authorized', micros(credits.pendingUsdc) === pending && micros(credits.reservedUsdc) === heldOnChain, { pendingUsdc: credits.pendingUsdc, reservedUsdc: credits.reservedUsdc, expectedPending: String(pending) });

  // Add funds (from Home's balance tile: in this remote-gateway setup the sidebar's opens the console instead).
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('main').getByRole('button', { name: 'Add funds', exact: true }).first().click({ timeout: SCREEN_WAIT_MS });
  const link = page.getByRole('button', { name: 'held in sessions', exact: true });
  await link.waitFor({ timeout: SCREEN_WAIT_MS }).catch(() => {});
  const card = (await ui.text()).replace(/\s+/g, ' ');
  tb.check('Add funds shows the reserve as held in sessions, as a link', card.includes(`${cardUsd(heldOnChain)} held in sessions`) && await link.isVisible(), { expected: `${cardUsd(heldOnChain)} held in sessions`, shown: card.match(/\$[\d.,]+ held in sessions/)?.[0] ?? 'no held amount' });
  await screenshots(ui, 'add-funds');

  // The console opens in the system browser, so the browser call is stubbed first; nothing is clicked unless it took.
  const stubbed = await ui.app.evaluate(({ shell }) => {
    globalThis.__issue1463Opened = [];
    shell.openExternal = async (url) => { globalThis.__issue1463Opened.push(url); };
    return String(shell.openExternal).includes('__issue1463Opened');
  });
  tb.check('the system browser is stubbed before the link is clicked', stubbed === true, { stubbed });
  await link.click();
  const opened = await tb.waitFor(async () => (await ui.app.evaluate(() => globalThis.__issue1463Opened))[0] ?? null, '"held in sessions" to open the console', { timeoutMs: 15_000, intervalMs: 250 }).catch(() => null);
  const target = opened ? new URL(opened) : null;
  tb.check('"held in sessions" opens the console\'s payment channels', target?.pathname === '/console/wallet' && target.searchParams.get('channels') === '1', { opened });

  // The exit itself runs through the CLI: the console's close needs a browser wallet.
  for (const [name, channel] of [['retired', retired], ['fully signed', spent]]) {
    const requested = await tb.cli(['buyer', 'channels', 'request-close', channel.channelId, '--json']);
    tb.check(`buyer channels request-close accepts the ${name} channel`, requested.code === 0 && requested.json?.channelId === channel.channelId, { code: requested.code, stderr: requested.stderr.slice(-300), stdout: requested.stdout.slice(-300) });
    // The command stores the channel's new state itself: the buyer reports it without reading the chain again.
    const after = ((await tb.request('/_antseed/channels?all=1')).json?.channels ?? []).find((row) => row.channelId === channel.channelId);
    tb.check(`the ${name} channel shows its close request at once`, (after?.onChain?.closeRequestedAt ?? 0) > 0, after?.onChain ?? null);
  }
  const closing = await tb.waitFor(async () => {
    const rows = await console_.channels({ fresh: true });
    return [retired, spent].every((channel) => rows.find((entry) => entry.channelId === channel.channelId)?.status === 'closing') ? rows : null;
  }, 'the console to show both closing', { timeoutMs: SCREEN_WAIT_MS }).catch(() => null);
  tb.check('the console shows both channels closing during the grace period', closing !== null);

  await tb.warp(GRACE_SECONDS + 60);
  for (const channel of [retired, spent]) {
    const released = await tb.cli(['buyer', 'channels', 'withdraw', channel.channelId, '--json'], { clock: 'chain' });
    tb.check('buyer channels withdraw exits 0 after the grace', released.code === 0, { code: released.code, stderr: released.stderr.slice(-300) });
    tb.check('the channel timed out on-chain', (await tb.channelState(channel.channelId)).status === 3, await tb.channelState(channel.channelId));
  }
  const end = await tb.buyerBalance();
  tb.check('the whole reserve came back to the deposit', end.reserved === 0n && end.available === start.available + heldOnChain, { before: { available: String(start.available), reserved: String(start.reserved) }, after: { available: String(end.available), reserved: String(end.reserved) } });

  const after = await console_.channels({ fresh: true });
  tb.check('the console lists no open channel once the chain shows both ended', after.length === 0, after.map((entry) => [entry.channelId, entry.status]));
  tb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
  await ui.close();
  tb.metric('recovered', { heldOnChain: String(heldOnChain), retired: retired.channelId, spent: spent.channelId });
}
