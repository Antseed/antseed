import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyFlags,
  ChatOrganizationStore,
  emptyOrganization,
  flagsFor,
  forgetConversation,
  parseOrganization,
} from './chat-organization.js';

test('pinning and archiving record when, and each clears the other', () => {
  let org = applyFlags(emptyOrganization(), 'a', { pinned: true }, 100);
  assert.deepEqual(flagsFor(org, 'a'), { pinnedAt: 100 });
  org = applyFlags(org, 'a', { pinned: true }, 200);
  assert.deepEqual(flagsFor(org, 'a'), { pinnedAt: 100 }, 'pinning again keeps the first time');
  org = applyFlags(org, 'a', { archived: true }, 300);
  assert.deepEqual(flagsFor(org, 'a'), { archivedAt: 300 });
  org = applyFlags(org, 'a', { pinned: true }, 400);
  assert.deepEqual(flagsFor(org, 'a'), { pinnedAt: 400 });
  org = applyFlags(org, 'a', { pinned: false }, 500);
  assert.deepEqual(flagsFor(org, 'a'), {});
});

test('a malformed or partial file reads as what it can', () => {
  assert.deepEqual(parseOrganization('not json'), emptyOrganization());
  assert.deepEqual(
    parseOrganization(JSON.stringify({ pinned: { a: 5, b: 'x', c: -1 }, archived: [1] })),
    { version: 1, pinned: { a: 5 }, archived: {} },
  );
});

test('forgetting a chat drops both flags and leaves an untouched store as is', () => {
  const org = applyFlags(applyFlags(emptyOrganization(), 'a', { pinned: true }, 1), 'b', { archived: true }, 2);
  assert.deepEqual(forgetConversation(org, 'a'), { version: 1, pinned: {}, archived: { b: 2 } });
  assert.equal(forgetConversation(org, 'zzz'), org);
});

test('the store persists flags and reads them back after a restart', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'chat-org-')), 'nested', 'organization.json');
  const store = new ChatOrganizationStore(file);
  assert.deepEqual(await store.read(), emptyOrganization());
  const pinned = await store.setFlags('a', { pinned: true });
  assert.ok(pinned.pinnedAt);
  await store.setFlags('b', { archived: true });
  await store.forget('a');

  const reopened = new ChatOrganizationStore(file);
  const org = await reopened.read();
  assert.deepEqual(Object.keys(org.pinned), []);
  assert.deepEqual(Object.keys(org.archived), ['b']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
});

test('concurrent writes all land', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'chat-org-')), 'organization.json');
  writeFileSync(file, '{}');
  const store = new ChatOrganizationStore(file);
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.setFlags(id, { pinned: true })));
  const org = await new ChatOrganizationStore(file).read();
  assert.deepEqual(Object.keys(org.pinned).sort(), ['a', 'b', 'c', 'd']);
});
