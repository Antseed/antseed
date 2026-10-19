import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReferralStatus } from '../../types/bridge';
import { ReferralStatusRow } from './ReferralStatusRow';

const REFERRER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7';
const invited: ReferralStatus = { configured: true, state: 'invited', referrer: REFERRER, invite: 'AQAe' };
const buttons = (html: string) => (html.match(/<button\b[^>]*>.*?<\/button>/g) ?? []).map((button) => button.replace(/<[^>]+>/g, ''));

describe('ReferralStatusRow', () => {
  it('offers to change or remove a pending invite', () => {
    const html = renderToStaticMarkup(<ReferralStatusRow status={invited} />);
    expect(html).toContain('Pending. Binds with your first paid or free request.');
    expect(buttons(html)).toEqual(['Change', 'Remove']);
    expect(html).not.toContain('name="invite-code"');
  });

  it('keeps a binding final', () => {
    const html = renderToStaticMarkup(<ReferralStatusRow status={{ ...invited, state: 'bound', invite: null }} />);
    expect(html).toContain('Bound on-chain.');
    expect(buttons(html)).toEqual([]);
  });

  it('replaces a pending invite through the invite field, with a way back', () => {
    const html = renderToStaticMarkup(<ReferralStatusRow status={invited} initialChanging />);
    expect(html).toContain('name="invite-code"');
    expect(buttons(html)).toEqual(['Use invite', 'Cancel']);
  });

  it('never opens the field over a binding', () => {
    const html = renderToStaticMarkup(<ReferralStatusRow status={{ ...invited, state: 'bound', invite: null }} initialChanging />);
    expect(html).not.toContain('name="invite-code"');
  });

  it('shows the invite field without an inviter', () => {
    const html = renderToStaticMarkup(<ReferralStatusRow status={{ configured: true, state: 'none', referrer: null, invite: null }} />);
    expect(html).toContain('name="invite-code"');
    expect(buttons(html)).toEqual(['Use invite']);
  });
});
