import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prefillUrl, sourceOf} from './waitlist.ts';
import type {Answers} from './macs.ts';

const answers: Answers = {mac: 'MacBook Pro', chip: 'M2 Pro', memory: '16 GB', name: 'Ada'};
const form = {formUrl: 'https://docs.google.com/forms/d/e/ABC/viewform', fields: {mac: 'entry.1', chip: 'entry.2', memory: 'entry.3', name: 'entry.4', source: 'entry.5'}};

test('the prefilled form carries every answer into its entry field', () => {
  const url = new URL(prefillUrl(form, answers, 'abc234')!);
  assert.equal(url.origin + url.pathname, 'https://docs.google.com/forms/d/e/ABC/viewform');
  assert.equal(url.searchParams.get('usp'), 'pp_url');
  assert.equal(url.searchParams.get('entry.1'), 'MacBook Pro');
  assert.equal(url.searchParams.get('entry.4'), 'Ada');
  assert.equal(url.searchParams.get('entry.5'), 'abc234');
});

test('no form, no link', () => {
  assert.equal(prefillUrl(null, answers, 'direct'), null);
  assert.equal(prefillUrl({formUrl: null, fields: {}}, answers, 'direct'), null);
});

test('an empty answer is left out of the form, not sent blank', () => {
  const url = new URL(prefillUrl(form, {...answers, chip: '', memory: ''}, 'direct')!);
  assert.equal(url.searchParams.has('entry.2'), false);
  assert.equal(url.searchParams.has('entry.3'), false);
  assert.equal(url.searchParams.get('entry.1'), 'MacBook Pro');
});

test('the invite link wins over utm_source and the referring site', () => {
  assert.equal(sourceOf('?ref=abc234&utm_source=x', 'https://t.co/1'), 'abc234');
  assert.equal(sourceOf('?utm_source=newsletter', 'https://t.co/1'), 'newsletter');
  assert.equal(sourceOf('', 'https://t.co/1'), 't.co');
  assert.equal(sourceOf('', ''), 'direct');
});
