import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { initStore } from '../../core/store';
import { openGatewayConsole } from '../../modules/app/console-launch';
import { navViews } from './viewRegistry';
import { SidebarNavItem, VprShell } from './VprShell';

vi.mock('../hooks/useActions', () => ({ useActions: () => ({}) }));
vi.mock('../../modules/app/console-launch', () => ({
  openGatewayConsole: vi.fn(async () => true),
  dismissConsoleLaunchFailure: vi.fn(),
  useConsoleLaunchFailure: () => null,
}));

beforeEach(() => {
  initStore(createInitialUiState());
  vi.mocked(openGatewayConsole).mockClear();
});

const gatewayEntry = navViews('bottom').find((entry) => entry.view === 'gateway')!;

/** Renders a nav item through React (so its hooks run) and returns the button it rendered. */
function renderNavItem(props: ComponentProps<typeof SidebarNavItem>): ReactElement<{ onClick: () => void }> {
  let button: ReactElement<{ onClick: () => void }> | null = null;
  function Probe() {
    button = SidebarNavItem(props) as ReactElement<{ onClick: () => void }>;
    return button;
  }
  renderToStaticMarkup(<Probe />);
  expect(button).not.toBeNull();
  return button!;
}

function shell(activeView: 'home' | 'gateway') {
  return renderToStaticMarkup(
    <VprShell activeView={activeView} onSelectView={vi.fn()} onNavigateBack={vi.fn()}>
      <div>View content</div>
    </VprShell>,
  );
}

it('names the sidebar item Gateway, above Settings, where Dashboard was', () => {
  const markup = shell('home');
  expect(markup).not.toContain('Dashboard');
  expect(markup.indexOf('>Gateway</span>')).toBeGreaterThan(0);
  expect(markup.indexOf('>Gateway</span>')).toBeLessThan(markup.indexOf('>Settings</span>'));
});

it('marks Gateway as the current page while it is open', () => {
  const current = (markup: string) => markup.match(/<button[^>]*aria-current="page"[^>]*>.*?<\/button>/g) ?? [];
  expect(current(shell('gateway')).join('')).toContain('>Gateway</span>');
  expect(current(shell('home')).join('')).not.toContain('>Gateway</span>');
});

it('opens the Gateway page in the app, not the console in the browser', () => {
  const onSelectView = vi.fn();
  renderNavItem({ entry: gatewayEntry, active: false, collapsed: false, onSelectView }).props.onClick();
  expect(onSelectView).toHaveBeenCalledWith('gateway');
  expect(openGatewayConsole).not.toHaveBeenCalled();
});

it('names Gateway on the collapsed rail', () => {
  const markup = renderToStaticMarkup(
    <SidebarNavItem entry={gatewayEntry} active={false} collapsed onSelectView={vi.fn()} />,
  );
  expect(markup).toContain('aria-label="Gateway"');
  expect(markup).toContain('title="Gateway"');
});

it('renders what it is given after the label, for a status dot', () => {
  const markup = renderToStaticMarkup(
    <SidebarNavItem entry={gatewayEntry} active={false} collapsed={false} onSelectView={vi.fn()}>
      <span aria-label="Status dot" />
    </SidebarNavItem>,
  );
  expect(markup).toMatch(/>Gateway<\/span><span aria-label="Status dot"><\/span><\/button>/);
});

it('renders Home and the main entries as standard nav items, keeping the Apps dot', () => {
  const markup = shell('home');
  const buttons = markup.match(/<button[^>]*>.*?<\/button>/g) ?? [];
  const home = buttons.find((button) => button.includes('>Home</span>'));
  expect(home).toContain('aria-current="page"');
  const apps = buttons.find((button) => button.includes('aria-label="Connect your apps"'));
  expect(apps).toBeDefined();
  expect(apps).not.toContain('aria-current');
});
