import {describe, expect, it} from 'vitest';
import {parseUtm, referrerHost} from './referrer';

describe('referrerHost', () => {
  it('maps public hosts and their subdomains to one label', () => {
    expect(referrerHost('https://github.com/AntSeed/antseed')).toBe('github.com');
    expect(referrerHost('https://old.reddit.com/r/LocalLLaMA/comments/x')).toBe('reddit.com');
    expect(referrerHost('https://t.co/abc')).toBe('x.com');
    expect(referrerHost('https://chat.openai.com/c/123')).toBe('chatgpt.com');
    expect(referrerHost('https://www.google.co.uk/')).toBe('google.com');
    expect(referrerHost('https://docs.antseed.com/guides/install')).toBe('antseed.com');
    expect(referrerHost('https://l.facebook.com/l.php?u=')).toBe('facebook.com');
  });

  it('hides private and unknown hosts behind "other"', () => {
    expect(referrerHost('https://acme.slack.com/archives/C1')).toBe('other');
    expect(referrerHost('https://wiki.somecompany.internal/page')).toBe('other');
    expect(referrerHost('https://mail.example.org/')).toBe('other');
  });

  it('returns none for missing or malformed referrers', () => {
    expect(referrerHost(null)).toBe('none');
    expect(referrerHost('')).toBe('none');
    expect(referrerHost('not a url')).toBe('none');
  });

  it('never leaks path or query', () => {
    const r = referrerHost('https://github.com/AntSeed/antseed?token=secret#frag');
    expect(r).toBe('github.com');
  });
});

describe('parseUtm', () => {
  it('keeps well-shaped source, medium and campaign, lowercased', () => {
    const p = new URLSearchParams('utm_source=GitHub&utm_medium=readme&utm_campaign=v0.2.38&utm_term=x');
    expect(parseUtm(p)).toEqual({link_source: 'github', link_medium: 'readme', link_campaign: 'v0.2.38'});
  });

  it('drops malformed values', () => {
    const p = new URLSearchParams('utm_source=<script>&utm_medium=' + 'a'.repeat(70));
    expect(parseUtm(p)).toEqual({});
  });
});
