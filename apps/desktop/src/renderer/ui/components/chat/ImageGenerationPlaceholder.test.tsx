import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isImageRequestPhase } from './chat-shared';
import { ImageGenerationPlaceholder } from './ImageGenerationPlaceholder';

test('image phases include both first generations and follow-up edits', () => {
  assert.equal(isImageRequestPhase('Generating image'), true);
  assert.equal(isImageRequestPhase('Editing image'), true);
  assert.equal(isImageRequestPhase('Calling tool'), false);
});

test('image generation placeholder announces generation state', () => {
  const markup = renderToStaticMarkup(<ImageGenerationPlaceholder />);
  assert.match(markup, /role="status"/);
  assert.match(markup, /Generating your image/);
});

test('image generation placeholder announces edit state', () => {
  const markup = renderToStaticMarkup(<ImageGenerationPlaceholder editing />);
  assert.match(markup, /Editing your image/);
});
