import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayPrivacy, GatewayPrivacyMode } from '../../types/bridge';

type Pending = { mode: GatewayPrivacyMode; settle: (result: { ok: boolean; privacy?: GatewayPrivacy; error?: string }) => void };

const privacy = (mode: GatewayPrivacyMode): GatewayPrivacy => ({ mode, editable: true, requiredAbove: false });

async function setup() {
  vi.resetModules();
  const calls: Pending[] = [];
  vi.stubGlobal('window', {
    antseedDesktop: {
      gatewaySetPrivacy: (mode: GatewayPrivacyMode) => new Promise((settle) => calls.push({ mode, settle })),
      gatewayGetPrivacy: async () => ({ ok: true, privacy: privacy('anonymous') }),
    },
  });
  const resources = await import('./vpr-resources');
  resources.privacyResource.setData(privacy('anonymous'));
  const shownMode = () => resources.privacyResource.getSnapshot().data?.mode;
  return { ...resources, calls, shownMode };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('requestPrivacyMode', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('shows the mode at once and holds sending until the gateway confirms', async () => {
    const { requestPrivacyMode, getPrivacySwitchState, calls, shownMode } = await setup();
    const done = requestPrivacyMode('private');
    expect(shownMode()).toBe('private');
    expect(getPrivacySwitchState().switching).toBe(true);
    calls[0].settle({ ok: true, privacy: privacy('private') });
    await done;
    expect(shownMode()).toBe('private');
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: null });
  });

  it('drops a failed switch\'s error once the gateway changes', async () => {
    const { requestPrivacyMode, clearPrivacySwitchError, getPrivacySwitchState, calls } = await setup();
    const done = requestPrivacyMode('private');
    calls[0].settle({ ok: false, error: 'nope' });
    await done;
    expect(getPrivacySwitchState().error).toBe('nope');
    clearPrivacySwitchError();
    expect(getPrivacySwitchState().error).toBeNull();
  });

  it('restores the confirmed mode and reports the error when the write fails', async () => {
    const { requestPrivacyMode, getPrivacySwitchState, calls, shownMode } = await setup();
    const done = requestPrivacyMode('private');
    calls[0].settle({ ok: false, error: 'gateway down' });
    await done;
    expect(shownMode()).toBe('anonymous');
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: 'gateway down' });
  });

  it('applies only the latest choice after a flip mid-way, and keeps holding until then', async () => {
    const { requestPrivacyMode, getPrivacySwitchState, calls, shownMode } = await setup();
    const done = requestPrivacyMode('private');
    void requestPrivacyMode('anonymous');
    expect(shownMode()).toBe('anonymous');
    calls[0].settle({ ok: true, privacy: privacy('private') });
    await tick();
    expect(getPrivacySwitchState().switching).toBe(true);
    expect(shownMode()).toBe('anonymous');
    expect(calls.map((call) => call.mode)).toEqual(['private', 'anonymous']);
    calls[1].settle({ ok: true, privacy: privacy('anonymous') });
    await done;
    expect(shownMode()).toBe('anonymous');
    expect(getPrivacySwitchState().switching).toBe(false);
  });

  it('does not let a poll landing mid-switch flip the screen back', async () => {
    const { requestPrivacyMode, privacyResource, calls, shownMode } = await setup();
    const done = requestPrivacyMode('private');
    await privacyResource.refresh();
    expect(shownMode()).toBe('private');
    calls[0].settle({ ok: true, privacy: privacy('private') });
    await done;
  });
});
