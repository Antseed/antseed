import assert from 'node:assert/strict';
import { test } from 'vitest';
import { deriveFundingStatus, formatUsd, sweepAmountNeeded, usdcToBaseUnits, type FundingInputs } from './funding-status';

const base: FundingInputs = {
  available: '0',
  reserved: '0',
  wallet: '0',
  creditLimit: '100',
  minFirstDeposit: '1',
  depositFee: '0.05',
};

function channel(overrides: Partial<NonNullable<FundingInputs['channels']>[number]> = {}) {
  return {
    peerId: '0xabcdef0123456789abcdef0123456789abcdef01',
    sellerDisplayName: 'Openforge',
    status: 'active',
    onChainStateKnown: true,
    onChainDeposit: '1000000',
    onChainSettled: '0',
    cumulativeSigned: '250000',
    ...overrides,
  };
}

test('parses and formats USDC amounts without float drift', () => {
  assert.equal(usdcToBaseUnits('1.05'), 1_050_000n);
  assert.equal(usdcToBaseUnits('0.000001'), 1n);
  assert.equal(usdcToBaseUnits('garbage'), 0n);
  assert.equal(formatUsd(1_050_000n), '$1.05');
  assert.equal(formatUsd(549_999n), '$0.55');
  // Shortfalls round up so sending the shown amount always clears them.
  assert.equal(formatUsd(540_001n, 'up'), '$0.55');
});

test('an empty account explains the first-deposit minimum including the fee', () => {
  const status = deriveFundingStatus(base);
  assert.equal(status.kind, 'empty');
  assert.equal(status.sendMoreBaseUnits, 1_050_000n);
  assert.match(status.title, /\$1\.05/);
});

test('an unread balance stays silent instead of asking for a first deposit', () => {
  const status = deriveFundingStatus({ ...base, balanceKnown: false });
  assert.equal(status.kind, 'loading');
  assert.equal(status.tone, 'ok');
  assert.deepEqual(status.actions, []);
  assert.equal(status.sendMoreBaseUnits, null);
});

test('$0.50 in the wallet asks for exactly $0.55 more', () => {
  const status = deriveFundingStatus({ ...base, wallet: '0.5' });
  assert.equal(status.kind, 'wallet-below-minimum');
  assert.equal(status.tone, 'warning');
  assert.equal(status.sendMoreBaseUnits, 550_000n);
  assert.match(status.title, /Send \$0\.55 more/);
});

test('exactly $1.00 in the wallet is $0.05 short of the first deposit', () => {
  const status = deriveFundingStatus({ ...base, wallet: '1' });
  assert.equal(status.kind, 'wallet-below-minimum');
  assert.equal(status.sendMoreBaseUnits, 50_000n);
  assert.match(status.body, /\$1\.05 \(\$1\.00 \+ \$0\.05 network fee\)/);
});

test('$1.05 in the wallet clears the minimum and reads as depositing', () => {
  const status = deriveFundingStatus({ ...base, wallet: '1.05' });
  assert.equal(status.kind, 'depositing');
  assert.equal(status.tone, 'info');
  assert.match(status.title, /\$1\.00/);
});

test('the minimum and fee come from the inputs, not constants', () => {
  const status = deriveFundingStatus({ ...base, wallet: '1.05', minFirstDeposit: '2', depositFee: '0.10' });
  assert.equal(status.kind, 'wallet-below-minimum');
  assert.equal(status.sendMoreBaseUnits, 1_050_000n);
});

test('a $1.00 deposit fully held by one session names the seller and the way out', () => {
  const status = deriveFundingStatus({ ...base, reserved: '1', channels: [channel()] });
  assert.equal(status.kind, 'all-reserved');
  assert.equal(status.tone, 'warning');
  assert.match(status.title, /Openforge/);
  assert.deepEqual(status.actions, ['add-funds', 'manage-sessions']);
  // $1.00 block + $0.05 fee.
  assert.equal(status.sendMoreBaseUnits, 1_050_000n);
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0]!.unusedBaseUnits, 750_000n);
});

test('partial availability below one session block is still blocked', () => {
  const status = deriveFundingStatus({ ...base, available: '0.5', reserved: '1' });
  assert.equal(status.kind, 'all-reserved');
  assert.match(status.title, /\$0\.50 free/);
  assert.equal(status.sendMoreBaseUnits, 550_000n);
});

test('2.33 total with 1.00 reserved leaves 1.33 available and is ready', () => {
  const status = deriveFundingStatus({ ...base, available: '1.33', reserved: '1' });
  assert.equal(status.kind, 'ready');
  assert.equal(status.tone, 'ok');
});

test('low available credits with nothing reserved', () => {
  const status = deriveFundingStatus({ ...base, available: '0.4' });
  assert.equal(status.kind, 'low-available');
  assert.equal(status.sendMoreBaseUnits, 650_000n);
});

test('a pending top-up that covers the next session is shown as depositing, not as a shortfall', () => {
  const status = deriveFundingStatus({ ...base, reserved: '1', wallet: '2' });
  assert.equal(status.kind, 'depositing');
});

test('a top-up below the deposit floor is explained, not hidden', () => {
  const status = deriveFundingStatus({ ...base, available: '5', wallet: '0.03' });
  assert.equal(status.kind, 'wallet-dust');
  assert.equal(status.tone, 'info');
});

test('wallet funds above the credit limit wait for headroom', () => {
  const status = deriveFundingStatus({ ...base, available: '8', creditLimit: '8', wallet: '5' });
  assert.equal(status.kind, 'wallet-at-limit');
});

test('a top-up larger than sub-minimum headroom waits, like the watcher', () => {
  const status = deriveFundingStatus({ ...base, available: '7.5', creditLimit: '8', wallet: '5' });
  assert.equal(status.kind, 'wallet-at-limit');
});

test('a top-up that fits the remaining headroom still deposits', () => {
  const status = deriveFundingStatus({ ...base, available: '5', creditLimit: '8', wallet: '2' });
  assert.equal(status.kind, 'depositing');
});

test('a top-up below the deposit floor is held, like the watcher', () => {
  const status = deriveFundingStatus({ ...base, available: '5', wallet: '0.4' });
  assert.equal(status.kind, 'wallet-dust');
});

test('a clamped top-up waits until half the credit limit is free', () => {
  const waiting = deriveFundingStatus({ ...base, available: '30', creditLimit: '50', wallet: '40' });
  assert.equal(waiting.kind, 'wallet-at-limit');
  const ready = deriveFundingStatus({ ...base, available: '25', creditLimit: '50', wallet: '40' });
  assert.equal(ready.kind, 'depositing');
});

test('closed or zero-held channels are not listed as sessions', () => {
  const status = deriveFundingStatus({
    ...base,
    reserved: '1',
    channels: [
      channel({ status: 'settled' }),
      channel({ sellerDisplayName: null, onChainSettled: '1000000', cumulativeSigned: '1000000' }),
    ],
  });
  assert.equal(status.sessions.length, 0);
  assert.match(status.title, /open sessions/);
});

test('a top-up to a funded account still needs the minimum deposit plus the fee, net of the wallet', () => {
  // $1 minimum, $0.05 fee: a $0.50 top-up into an empty wallet would sit there unswept.
  assert.equal(sweepAmountNeeded(1_000_000n, 50_000n, 0n), 1_050_000n);
  assert.equal(sweepAmountNeeded(1_000_000n, 50_000n, 500_000n), 550_000n);
  assert.equal(sweepAmountNeeded(1_000_000n, 50_000n, 2_000_000n), 0n);
});
