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
