import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import {test} from 'node:test';
import {macLine, readCard, readLink, shareText, shareUrl} from './cardFacts.ts';
import {MACS} from './macs.ts';
import {sharePage} from './sharePages.ts';

test('the card page shows the name and Mac this browser kept from the sign-up', () => {
  assert.deepEqual(readCard('{"name":"Ada","mac":"MacBook Pro · M3 Max · 36 GB"}'), {name: 'Ada', mac: 'MacBook Pro · M3 Max · 36 GB'});
  assert.deepEqual(readCard(null), {name: '', mac: ''});
  assert.deepEqual(readCard('not json'), {name: '', mac: ''});
});

test('nothing kept in the browser can put made-up words on the card', () => {
  assert.equal(readCard('{"mac":"Free money"}').mac, '');
  assert.equal(readCard(`{"name":"${'A'.repeat(90)}"}`).name.length, 40);
  assert.deepEqual(readCard('{"name":7,"mac":["Mac mini"]}'), {name: '', mac: ''});
});

test('the card names the Mac, its chip and memory, and nothing for someone without a Mac', () => {
  assert.equal(macLine({mac: 'Mac mini', chip: 'M4 Pro', memory: '48 GB'}), 'Mac mini · M4 Pro · 48 GB');
  assert.equal(macLine({mac: 'No Mac', chip: '', memory: ''}), '');
});

test('the post names their Mac, or says they joined when they have none', () => {
  assert.equal(shareText('Mac mini · M4 Pro · 48 GB'), 'Just put my Mac mini on the waitlist for the first Mac Colony on @AntSeed. It joins Macs into one AI provider. Who else is bringing a Mac?');
  assert.equal(shareText(''), 'Just joined the waitlist for the first Mac Colony on @AntSeed. It joins Macs into one AI provider. Who’s bringing a Mac?');
});

test('the welcome email link carries the waitlist number and the Mac, so the card works on any device', () => {
  assert.deepEqual(readLink('#n=42&mac=MacBook%20Pro%20%C2%B7%20M3%20Max%20%C2%B7%2036%20GB'), {number: 42, mac: 'MacBook Pro · M3 Max · 36 GB', noMac: false});
  assert.deepEqual(readLink('#n=43&mac=none'), {number: 43, mac: '', noMac: true});
  assert.equal(readLink(''), null);
  assert.equal(readLink('#mac=Mac%20mini'), null);
});

test('a made-up link can put no words on the card and no odd number', () => {
  assert.equal(readLink('#n=7&mac=Free%20money')?.mac, '');
  assert.equal(readLink('#n=0&mac=none'), null);
  assert.equal(readLink('#n=-3'), null);
  assert.equal(readLink('#n=12345678'), null);
  assert.equal(readLink('#n=4.5'), null);
  assert.deepEqual(Object.keys(readLink('#n=9&name=Mallory') ?? {}).sort(), ['mac', 'noMac', 'number']);
});

test('a post links to the page for its Mac, so the preview shows that Mac’s card', () => {
  assert.equal(shareUrl('MacBook Pro · M3 Max · 36 GB'), 'https://antseed.com/colony/mac/macbook-pro/');
  assert.equal(shareUrl('Mac mini'), 'https://antseed.com/colony/mac/mac-mini/');
  assert.equal(shareUrl(''), 'https://antseed.com/colony/');
  assert.equal(shareUrl('Free money'), 'https://antseed.com/colony/');
});

test('every Mac the sign-up offers has its share page and card picture', () => {
  const site = new URL('../../../../static/', import.meta.url);
  for (const mac of Object.keys(MACS)) {
    const {path, image, html} = sharePage(mac);
    assert.equal(path, new URL(shareUrl(mac)).pathname, `${mac}: a post links to its share page`);
    assert.match(html, new RegExp(`og:image" content="https://antseed\\.com${image}"`));
    assert.match(html, new RegExp(`twitter:image" content="https://antseed\\.com${image}"`));
    assert.match(html, new RegExp(`og:image:alt" content="My ${mac} wants in`), `${path} describes the ${mac} card`);
    assert.ok(statSync(new URL(`.${image}`, site)).size < 250_000, `${image} is small enough for every app's preview`);
  }
});
