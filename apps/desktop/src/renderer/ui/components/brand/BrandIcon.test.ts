import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';
import { BrandIcon, isThemeAwareAppBrand, resolveBrandKey } from './BrandIcon.js';

test('model family wins over the transport provider slug', () => {
  // Sellers advertise models over a protocol whose provider slug ("openai",
  // "anthropic") says nothing about the model's own brand.
  assert.equal(resolveBrandKey('openai', 'Kimi K3'), 'kimi');
  assert.equal(resolveBrandKey('openai', 'GLM 5.2'), 'glm');
  assert.equal(resolveBrandKey('openai', 'DeepSeek V4'), 'deepseek');
  assert.equal(resolveBrandKey('openai', 'Qwen 3.5'), 'qwen');
  assert.equal(resolveBrandKey('openai', 'Gemini 3 Pro'), 'gemini');
  assert.equal(resolveBrandKey('openai', 'Grok 4.5'), 'grok');
  assert.equal(resolveBrandKey('openai', 'Mistral Large'), 'mistral');
  assert.equal(resolveBrandKey('openai', 'MiniMax M2.7'), 'minimax');
  assert.equal(resolveBrandKey('openai', 'Llama 4'), 'llama');
  assert.equal(resolveBrandKey('anthropic', 'Kimi K3'), 'kimi');
});

test('vendor slugs still resolve their own models', () => {
  assert.equal(resolveBrandKey('anthropic', 'Claude Fable 5'), 'anthropic');
  assert.equal(resolveBrandKey('openai', 'Claude Opus 5'), 'anthropic');
  assert.equal(resolveBrandKey('openai-responses', 'Claude Sonnet 5'), 'anthropic');
  assert.equal(resolveBrandKey('claude-oauth', 'Claude Fable 5'), 'anthropic');
  assert.equal(resolveBrandKey('openai', 'GPT 5.6 Luna'), 'openai');
  assert.equal(resolveBrandKey('openai', 'gpt-5.6-sol'), 'openai');
  assert.equal(resolveBrandKey('openai-responses', 'minimax-m2-5'), 'minimax');
  assert.equal(resolveBrandKey('minimax', 'MiniMax M2.5'), 'minimax');
});

test('unknown identifiers fall back to the generic mark', () => {
  assert.equal(resolveBrandKey('acme', 'mystery-model'), 'generic');
  assert.equal(resolveBrandKey(), 'generic');
});

test('Droid resolves the Factory mark and stays theme-aware', () => {
  assert.equal(resolveBrandKey('droid', 'Droid'), 'droid');
  assert.equal(resolveBrandKey('factory'), 'droid');
  // Standalone-word match only — "android" must not become a Droid mark.
  assert.equal(resolveBrandKey('android-model'), 'generic');
  assert.equal(isThemeAwareAppBrand('droid'), true);
  const markup = renderToStaticMarkup(BrandIcon({ brand: 'droid', size: 24 }));
  assert.match(markup, /viewBox="0 0 508 508"/);
  assert.match(markup, /fill="currentColor"/);
});

test('MiniMax renders the official waveform and brand gradient', () => {
  const markup = renderToStaticMarkup(BrandIcon({ brand: 'minimax' }));
  assert.match(markup, /viewBox="0 0 32 32"/);
  assert.match(markup, /href="data:image\/png;base64,/);
});

test('GPT renders the official OpenAI blossom', () => {
  const markup = renderToStaticMarkup(BrandIcon({ name: 'GPT 5.6 Sol' }));
  assert.match(markup, /viewBox="0 0 16 16"/);
  assert.match(markup, /M12\.9851 6\.93777/);
  assert.match(markup, /fill="currentColor"/);
});

test('Hermes renders its portrait mark as a theme-aware SVG', () => {
  const markup = renderToStaticMarkup(BrandIcon({ name: 'hermes', hints: ['Hermes Agent'] }));
  assert.match(markup, /viewBox="0 0 200 200"/);
  assert.match(markup, /fill="currentColor"/);
  assert.doesNotMatch(markup, /mask-image/);
});

test('connected-app tool names resolve their marks', () => {
  assert.equal(resolveBrandKey('crush', 'Crush'), 'crush');
  assert.equal(resolveBrandKey('goose', 'Goose'), 'goose');
  assert.equal(resolveBrandKey('zed', 'Zed'), 'zed');
  assert.equal(resolveBrandKey('codex', 'Codex'), 'codex');
  assert.equal(resolveBrandKey('pi', 'pi'), 'pi');
  assert.equal(resolveBrandKey('gooeypi', 'GooeyPi'), 'pi');
  assert.equal(resolveBrandKey('prime-agent', 'Prime Agent'), 'prime-agent');
  assert.equal(resolveBrandKey('prime-intellect', 'INTELLECT-3'), 'generic');
  assert.equal(resolveBrandKey('hermes', 'Hermes Agent'), 'hermes');
  assert.equal(resolveBrandKey('hermes-agent'), 'hermes');
  assert.equal(resolveBrandKey('cursor', 'Cursor'), 'cursor');
  assert.equal(resolveBrandKey('openai', 'Hermes 4 70B'), 'openai');
  // Standalone-word guards: no false hits inside other identifiers.
  assert.equal(resolveBrandKey('amazed-tool', 'thing'), 'generic');
  assert.equal(resolveBrandKey('pixel-model', 'thing'), 'generic');
});

test('Cursor renders its bundled brand mark', () => {
  const markup = renderToStaticMarkup(BrandIcon({ name: 'cursor' }));
  assert.match(markup, /viewBox="0 0 24 24"/);
  assert.match(markup, /M11\.503\.131/);
  assert.match(markup, /fill="currentColor"/);
});

test('dark application marks use theme-aware brand rendering', () => {
  assert.equal(isThemeAwareAppBrand('cursor'), true);
  assert.equal(isThemeAwareAppBrand('hermes'), true);
  assert.equal(isThemeAwareAppBrand('codex'), false);
});

test('tunnel providers resolve their bundled brand marks', () => {
  assert.equal(resolveBrandKey('cloudflare', 'Cloudflare Tunnel'), 'cloudflare');
  assert.equal(resolveBrandKey('ngrok'), 'ngrok');
  assert.match(renderToStaticMarkup(BrandIcon({ name: 'cloudflare' })), /cloudflare\.svg/);
  assert.match(renderToStaticMarkup(BrandIcon({ name: 'ngrok' })), /ngrok\.svg/);
});
