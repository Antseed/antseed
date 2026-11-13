import { describe, expect, it } from 'vitest';
import { announcedProviderId, withDefaultServiceApiProtocols } from '../src/discovery/provider-id.js';

describe('announcedProviderId', () => {
  const key = new Uint8Array(32).fill(1);

  it('is 12 lowercase hex characters, stable for a seller and a name, whatever its case', () => {
    const id = announcedProviderId(key, 'fal-video');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(announcedProviderId(key, ' FAL-video ')).toBe(id);
    expect(announcedProviderId(key, 'openai')).not.toBe(id);
  });

  it('differs between sellers, so the plugin name cannot be looked up from it', () => {
    expect(announcedProviderId(new Uint8Array(32).fill(2), 'fal-video')).not.toBe(announcedProviderId(key, 'fal-video'));
  });
});

describe('withDefaultServiceApiProtocols', () => {
  it('fills the protocols buyers inferred from the provider name for services announcing none', () => {
    expect(withDefaultServiceApiProtocols('anthropic', ['a', 'b'], { b: ['openai-chat-completions'] })).toEqual({
      a: ['anthropic-messages'], b: ['openai-chat-completions'],
    });
    expect(withDefaultServiceApiProtocols('openai', ['a'], undefined)).toEqual({ a: ['openai-chat-completions'] });
  });

  it('leaves providers whose name implies no protocol unchanged', () => {
    const announced = { v: ['fal-video' as const] };
    expect(withDefaultServiceApiProtocols('fal-video', ['v', 'w'], announced)).toBe(announced);
    expect(withDefaultServiceApiProtocols('fal-video', ['v'], undefined)).toBeUndefined();
  });
});
