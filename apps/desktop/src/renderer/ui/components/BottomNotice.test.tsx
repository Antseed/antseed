import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';
import { BottomNotice } from './BottomNotice.js';
import styles from './BottomNotice.module.scss';

test('renders a dismissible danger bar with actions', () => {
  const markup = renderToStaticMarkup(
    <BottomNotice
      actions={[{ label: 'Retry', onClick: () => {} }]}
      align="start"
      body="Check your connection."
      dismissLabel="Dismiss connection warning"
      icon={<span>!</span>}
      onDismiss={() => {}}
      role="alert"
      title="Connection unavailable"
      tone="danger"
    />,
  );

  assert.match(markup, new RegExp(`class="[^"]*${styles.bar}`));
  assert.match(markup, new RegExp(`class="[^"]*${styles.danger}`));
  assert.match(markup, /role="alert"/);
  assert.match(markup, /aria-label="Dismiss connection warning"/);
  assert.match(markup, />Retry<\/button>/);
});

test('renders a polite overlay toast without forcing dismissal', () => {
  const markup = renderToStaticMarkup(
    <BottomNotice
      ariaLive="polite"
      body={'Model selected.\nExisting chats are unchanged.'}
      icon={<span>✓</span>}
      layout="toast"
      priority="overlay"
    />,
  );

  assert.match(markup, new RegExp(`class="[^"]*${styles.toast}`));
  assert.match(markup, new RegExp(`class="[^"]*${styles.overlay}`));
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.doesNotMatch(markup, /<button/);
});
