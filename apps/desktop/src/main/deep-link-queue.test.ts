import assert from 'node:assert/strict';
import test from 'node:test';
import { InviteLinkQueue } from './deep-link-queue.js';

function queue() {
  const sent: Array<[string, string]> = [];
  return { sent, links: new InviteLinkQueue<string>((renderer, invite) => { sent.push([renderer, invite]); }) };
}

test('a link that arrives after the page loaded but before the renderer subscribed is held for it', () => {
  const { sent, links } = queue();
  links.receive('AAA', 'window'); // loaded, but its listener is not installed yet
  assert.deepEqual(sent, []);
  assert.equal(links.take('window'), 'AAA');
  assert.equal(links.take('window'), null); // taken once
});

test('a ready renderer gets later links pushed', () => {
  const { sent, links } = queue();
  assert.equal(links.take('window'), null);
  links.receive('BBB', 'window');
  assert.deepEqual(sent, [['window', 'BBB']]);
  assert.equal(links.take('window'), null);
});

test('a renderer that reloads after subscribing gets the link once it asks again', () => {
  const { sent, links } = queue();
  links.take('window'); // subscribed while the document was still loading
  links.reset('window'); // then it navigated or reloaded
  links.receive('CCC', 'window');
  assert.deepEqual(sent, []);
  assert.equal(links.take('window'), 'CCC');
});

test('links wait while there is no window, and never go to a window that did not ask', () => {
  const { sent, links } = queue();
  links.receive('DDD', null);
  links.take('old');
  links.reset('old');
  links.receive('EEE', 'new');
  assert.deepEqual(sent, []);
  assert.equal(links.take('new'), 'EEE');
});
