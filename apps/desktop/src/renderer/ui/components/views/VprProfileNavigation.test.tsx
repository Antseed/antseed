import { Children, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { VprCard, VprPage } from '../vpr/VprKit';
import { VprCreditsView } from './VprCreditsView';
import { VprHelpView } from './VprHelpView';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({}) }));
vi.mock('../tunnels/PublicEndpointModal', () => ({
  usePublicEndpointModal: () => ({ status: null, openPublicEndpointModal: vi.fn() }),
}));
vi.mock('../vpr/VprKit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vpr/VprKit')>();
  return {
    ...actual,
    VprCard: vi.fn((props: ComponentProps<typeof actual.VprCard>) => <actual.VprCard {...props} />),
    VprPage: vi.fn((props: ComponentProps<typeof actual.VprPage>) => <actual.VprPage {...props} />),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  initStore(createInitialUiState());
});

function findButton(children: ReactNode, label: string): (() => void) | undefined {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) continue;
    if (child.type === 'button' && renderToStaticMarkup(child).includes(`>${label}<`)) {
      return child.props.onClick;
    }
    const nested = findButton(child.props.children, label);
    if (nested) return nested;
  }
  return undefined;
}

it('keeps Profile content without the network rewards card and shows Help after wallet details', () => {
  const markup = renderToStaticMarkup(<VprCreditsView />);
  for (const label of [
    'Your balance', 'Add Credits', 'Withdraw unused credits', 'Requests', 'Tokens',
    'Sellers', 'Payment channels', 'Signer', 'Wallet',
    'Back up private key', 'Import private key', 'Authorize a wallet', 'Help &amp; support',
  ]) {
    expect(markup).toContain(label);
  }
  expect(markup).not.toContain('Network rewards');
  expect(markup).not.toContain('ANTS pending this epoch');
  expect(markup).not.toContain('Earn ANTS from your usage');
  expect(markup.indexOf('Help &amp; support')).toBeGreaterThan(markup.indexOf('Authorize a wallet'));
});

it('keeps Help and Activity shortcuts on Profile without a Rewards shortcut', () => {
  const onSelectView = vi.fn();
  renderToStaticMarkup(<VprCreditsView onSelectView={onSelectView} />);
  const children = vi.mocked(VprCard).mock.calls.map(([props]) => props.children);
  expect(findButton(children, 'Rewards')).toBeUndefined();
  for (const [label, view] of [['Help', 'help'], ['Activity', 'activity']]) {
    const onClick = findButton(children, label);
    expect(onClick).toBeTypeOf('function');
    onClick?.();
    expect(onSelectView).toHaveBeenLastCalledWith(view);
  }
});

it('uses Profile as the Help root back fallback and retains its support content', () => {
  const markup = renderToStaticMarkup(<VprHelpView />);
  expect(vi.mocked(VprPage).mock.calls[0]?.[0]).toMatchObject({
    title: 'Help & Support',
    backFallback: 'credits',
  });
  expect(markup).toContain('Developer mode');
  expect(markup).toContain('Report a bug on GitHub');
});
