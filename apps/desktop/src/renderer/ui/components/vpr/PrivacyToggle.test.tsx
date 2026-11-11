import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { pendingHint, PrivacyNote, PrivacyToggle, type PrivacyControl } from './PrivacyToggle';
import styles from './PrivacyToggle.module.scss';

const control = (overrides: Partial<PrivacyControl>): PrivacyControl => ({
  current: 'private',
  pending: null,
  disabled: false,
  error: null,
  hint: 'Private hint',
  select: () => {},
  ...overrides,
});

beforeEach(() => {
  initStore(createInitialUiState());
});

it('shows Private as pending, not in effect, while connected apps still get it', () => {
  const pending = control({ pending: 'private', hint: pendingHint('private') });
  const toggle = renderToStaticMarkup(<PrivacyToggle control={pending} />);
  expect(toggle).toContain(styles.pending);
  expect(toggle).not.toContain(styles.activePrivate);

  const note = renderToStaticMarkup(<PrivacyNote control={pending} />);
  expect(note).toContain('Turning on Private');
  expect(note).not.toContain('<b>Private.</b>');
  expect(note).not.toContain(styles.notePrivate);
});

it('shows Private in effect once the gateway confirmed it', () => {
  const toggle = renderToStaticMarkup(<PrivacyToggle control={control({})} />);
  expect(toggle).toContain(styles.activePrivate);
  expect(toggle).not.toContain(styles.pending);
});

it('keeps a pending note up after "Got it", without the reminder that fades it out', () => {
  const store = new Map([['antseed:privacyNoteSeen', JSON.stringify({ anonymous: true, private: true })]]);
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } },
  };
  try {
    const note = renderToStaticMarkup(<PrivacyNote control={control({ current: 'anonymous', pending: 'private', hint: pendingHint('private') })} />);
    expect(note).toContain('Turning on Private');
    expect(note).not.toContain(styles.noteReminder);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

it('keeps an unconfirmed switch pending after an error, never shown as Private in effect', () => {
  // The write failed and so did the readback: connected apps may still be on Anonymous.
  const failed = control({ pending: 'private', error: 'gateway down', hint: 'gateway down' });
  const toggle = renderToStaticMarkup(<PrivacyToggle control={failed} />);
  expect(toggle).toContain(styles.pending);
  expect(toggle).not.toContain(styles.activePrivate);

  const note = renderToStaticMarkup(<PrivacyNote control={failed} />);
  expect(note).toContain('gateway down');
  expect(note).not.toContain('<b>Private.</b>');
  expect(note).not.toContain(styles.notePrivate);
});
