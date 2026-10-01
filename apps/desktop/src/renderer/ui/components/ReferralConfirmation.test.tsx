import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { initStore } from '../../core/store';
import { ReferralConfirmation } from './ReferralConfirmation';
import styles from './ReferralConfirmation.module.scss';

const REFERRER = '0x1111111111111111111111111111111111111111';

function renderWith(referralSetup: ReturnType<typeof createInitialUiState>['referralSetup']): string {
  const state = createInitialUiState();
  state.referralSetup = referralSetup;
  initStore(state);
  return renderToStaticMarkup(<ReferralConfirmation />);
}

test('renders the shared referral candidate from uiState', () => {
  const markup = renderWith({ state: 'candidate', referrer: REFERRER, confidence: 'probable' });
  assert.match(markup, new RegExp(`class="[^"]*${styles.referralCard}`));
  assert.match(markup, new RegExp(REFERRER));
  assert.match(markup, />Not my inviter<\/button>/);
  assert.match(markup, />Yes, this is my inviter<\/button>/);
});

test('renders nothing once the question was answered', () => {
  assert.equal(renderWith({ state: 'declined' }), '');
  assert.equal(renderWith({ state: 'accepted', referrer: REFERRER }), '');
  assert.equal(renderWith({ state: 'none' }), '');
});
