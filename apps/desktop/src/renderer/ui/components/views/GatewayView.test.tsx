import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModel, GatewayStatus } from '../../../types/bridge';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { curlSnippet, exampleModelId, gatewayChip, GatewayPage, GatewayView, type GatewayPageProps } from './GatewayView';

function status(overrides: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    mode: 'local',
    origin: 'http://127.0.0.1:10378',
    keyMode: 'auto',
    running: true,
    reachable: true,
    starting: false,
    hasKey: true,
    lastError: null,
    ...overrides,
  } as GatewayStatus;
}

const REMOTE = status({ mode: 'remote', origin: 'https://gateway.example.com' });

function props(overrides: Partial<GatewayPageProps> = {}): GatewayPageProps {
  return {
    status: REMOTE,
    modelId: 'example-model',
    trying: false,
    onTry: vi.fn(),
    onBack: vi.fn(),
    onOpenConsole: vi.fn(),
    onCreateKey: vi.fn(),
    ...overrides,
  };
}

function model(id: string, overrides: Partial<ChatModel> = {}): ChatModel {
  return { id, label: id, type: 'text', protocol: 'openai-chat-completions', free: false, ...overrides } as ChatModel;
}

/** The text an element carries directly, without rendering the components inside it. */
function ownText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(ownText).join('');
  return '';
}

/** Finds the clickable element whose own text is `label` in an unrendered element tree. */
function findByText(node: ReactNode, label: string): { props: { onClick?: () => void } } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByText(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  if (node.props.onClick && ownText(node.props.children).trim() === label) return node;
  return findByText(node.props.children, label);
}

function click(tree: ReactNode, label: string): void {
  const element = findByText(tree, label);
  expect(element, `a control labelled "${label}"`).not.toBeNull();
  element?.props.onClick?.();
}

describe('gateway status chip', () => {
  it('says Online, plus the host when the gateway is remote', () => {
    expect(gatewayChip(status())).toEqual({ text: 'Online', warn: false });
    expect(gatewayChip(REMOTE)).toEqual({ text: 'Online · gateway.example.com', warn: false });
  });

  it('flags a gateway that does not answer', () => {
    expect(gatewayChip(status({ reachable: false, starting: true }))).toEqual({ text: 'Starting', warn: false });
    expect(gatewayChip(status({ reachable: false }))).toEqual({ text: 'Unreachable', warn: true });
    expect(gatewayChip(undefined).text).toBe('Starting');
  });
});

describe('Gateway page', () => {
  it('sells the gateway with one card and one brand action', () => {
    const markup = renderToStaticMarkup(<GatewayPage {...props()} />);
    expect(markup).toContain('Online · gateway.example.com');
    expect(markup).toContain('Host it once. Share it with anyone.');
    expect(markup).toContain('Give people, agents and your company their own keys, limits and usage.');
    for (const [title, text] of [
      ['People', 'Give a friend or teammate their own key with a spending limit.'],
      ['Your running agents', 'Point any agent or script at your gateway with an API key.'],
      ['Your company', 'Invite your organization, set rules once, see usage per person.'],
    ]) {
      expect(markup).toContain(`>${title}</h2>`);
      expect(markup).toContain(text);
    }
    expect(markup).toContain('Try it out');
    expect(markup).toContain('Open full console');
    expect(markup.match(/as-button--brand/g)).toHaveLength(1);
    expect(markup).not.toContain('Create a key');
  });

  it.each([
    ['local', status()],
    ['remote', REMOTE],
  ])('never calls the %s gateway local or this computer’s', (_mode, gatewayStatus) => {
    for (const trying of [false, true]) {
      const markup = renderToStaticMarkup(<GatewayPage {...props({ status: gatewayStatus, trying })} />);
      expect(markup).not.toMatch(/local|this computer/i);
    }
  });

  it('opens the try-out from Try it out, and the console from its link', () => {
    const page = props();
    const tree = GatewayPage(page);
    click(tree, 'Try it out');
    expect(page.onTry).toHaveBeenCalledOnce();
    click(tree, 'Open full console');
    expect(page.onOpenConsole).toHaveBeenCalledWith('/');
  });

  it('shows the three try-out steps with the gateway URL and a model from its list', () => {
    const markup = renderToStaticMarkup(<GatewayPage {...props({ trying: true })} />);
    expect(markup).toContain('Try your gateway');
    expect(markup).toContain('Create a key');
    expect(markup).toContain('Call it from anything');
    expect(markup).toContain('See it arrive');
    expect(markup).toContain('curl https://gateway.example.com/v1/chat/completions');
    expect(markup).toContain('Bearer &lt;your key&gt;');
    expect(markup).toContain('example-model');
    expect(markup).toContain('Open full console');
    expect(markup).not.toContain('Try it out');
    expect(markup.match(/as-button--brand/g)).toHaveLength(1);
  });

  it('wires each try-out step to the existing console pages, and Back to the overview', () => {
    const page = props({ trying: true });
    const tree = GatewayPage(page);
    click(tree, 'Create a key');
    expect(page.onCreateKey).toHaveBeenCalledOnce();
    click(tree, 'Open the request log');
    expect(page.onOpenConsole).toHaveBeenCalledWith('/logs');
    click(tree, 'Open full console');
    expect(page.onOpenConsole).toHaveBeenLastCalledWith('/');
    click(tree, 'Back');
    expect(page.onBack).toHaveBeenCalledOnce();
  });
});

describe('try-out example', () => {
  it('uses the model chat uses, else a free chat model, else any chat model', () => {
    const models = [model('image-model', { protocol: null, type: 'image' }), model('paid'), model('free-one', { free: true })];
    expect(exampleModelId(models, 'paid')).toBe('paid');
    expect(exampleModelId(models, `${'ab'.repeat(20)}@paid`)).toBe('paid');
    expect(exampleModelId(models, 'image-model')).toBe('free-one');
    expect(exampleModelId([model('paid')], null)).toBe('paid');
    expect(exampleModelId([], null)).toBe('<model>');
  });

  it('never picks a model only low-trust sellers serve, unless chat uses it', () => {
    const models = [model('junk-free', { free: true, lowTrust: true }), model('trusted-paid'), model('trusted-free', { free: true })];
    expect(exampleModelId(models, null)).toBe('trusted-free');
    expect(exampleModelId(models.slice(0, 2), null)).toBe('trusted-paid');
    expect(exampleModelId(models, 'junk-free')).toBe('junk-free');
    expect(exampleModelId([model('junk', { lowTrust: true })], null)).toBe('junk');
  });

  it('builds a Chat Completions call with a key placeholder', () => {
    const snippet = curlSnippet('https://gateway.example.com/', 'example-model');
    expect(snippet.split('\n')[0]).toBe('curl https://gateway.example.com/v1/chat/completions \\');
    expect(snippet).toContain('-H "Authorization: Bearer <your key>"');
    expect(snippet).toContain(`-d '{"model":"example-model","messages":[{"role":"user","content":"Hello"}]}'`);
    expect(curlSnippet(null, 'm')).toContain('curl <gateway-url>/v1/chat/completions');
  });
});

describe('Gateway view', () => {
  beforeEach(() => {
    initStore(createInitialUiState());
  });

  it('renders the overview first, on the home field layout', () => {
    const markup = renderToStaticMarkup(<GatewayView />);
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('Host it once. Share it with anyone.');
    expect(markup).not.toContain('Call it from anything');
  });
});
