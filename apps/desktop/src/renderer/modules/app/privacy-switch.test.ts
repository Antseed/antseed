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

  it('marks the asked-for mode as pending until every key has it', async () => {
    const { requestPrivacyMode, getPrivacySwitchState, calls } = await setup();
    const done = requestPrivacyMode('private');
    // The gateway is still applying it to the connected apps' keys.
    expect(getPrivacySwitchState()).toMatchObject({ switching: true, target: 'private' });
    calls[0].settle({ ok: true, privacy: privacy('private') });
    await done;
    expect(getPrivacySwitchState().target ?? null).toBeNull();
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

  it('still applies a newer choice when the write before it fails', async () => {
    const { requestPrivacyMode, getPrivacySwitchState, calls, shownMode } = await setup();
    const done = requestPrivacyMode('private');
    void requestPrivacyMode('anonymous');
    calls[0].settle({ ok: false, error: 'gateway busy' });
    await tick();
    expect(calls.map((call) => call.mode)).toEqual(['private', 'anonymous']);
    expect(getPrivacySwitchState().switching).toBe(true);
    calls[1].settle({ ok: true, privacy: privacy('anonymous') });
    await done;
    expect(shownMode()).toBe('anonymous');
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: null });
  });

  it('reads the mode back when a write fails, since it may have landed', async () => {
    const { requestPrivacyMode, getPrivacySwitchState, calls, shownMode } = await setup();
    (window as any).antseedDesktop.gatewayGetPrivacy = async () => ({ ok: true, privacy: privacy('private') });
    const done = requestPrivacyMode('private');
    calls[0].settle({ ok: false, error: 'the read after the write failed' });
    await done;
    expect(shownMode()).toBe('private');
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: 'the read after the write failed' });
  });

  it('keeps sending held while the mode is unknown, until a read succeeds', async () => {
    const { requestPrivacyMode, privacyResource, getPrivacySwitchState, calls } = await setup();
    let readable = false;
    (window as any).antseedDesktop.gatewayGetPrivacy = async () => (readable
      ? { ok: true, privacy: privacy('anonymous') }
      : { ok: false, error: 'gateway down' });
    (window as any).setTimeout = () => 0;
    const done = requestPrivacyMode('private');
    calls[0].settle({ ok: false, error: 'nope' });
    await done;
    // Still pending, not in effect: the gateway hasn't said which mode it is in.
    expect(getPrivacySwitchState()).toEqual({ switching: true, error: 'nope', target: 'private' });
    readable = true;
    await privacyResource.refresh();
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: 'nope' });
    expect(privacyResource.getSnapshot().data?.mode).toBe('anonymous');
  });

  it('does not let a read that began before a switch overwrite its result', async () => {
    const { requestPrivacyMode, privacyResource, calls, shownMode } = await setup();
    let finishRead: (result: { ok: boolean; privacy: GatewayPrivacy }) => void = () => {};
    (window as any).antseedDesktop.gatewayGetPrivacy = () => new Promise((resolve) => { finishRead = resolve; });
    const poll = privacyResource.refresh();
    const done = requestPrivacyMode('private');
    calls[0].settle({ ok: true, privacy: privacy('private') });
    await done;
    finishRead({ ok: true, privacy: privacy('anonymous') });
    await poll;
    expect(shownMode()).toBe('private');
  });

  it('does not let a poll landing mid-switch flip the screen back', async () => {
    const { requestPrivacyMode, privacyResource, calls, shownMode } = await setup();
    const done = requestPrivacyMode('private');
    await privacyResource.refresh();
    expect(shownMode()).toBe('private');
    calls[0].settle({ ok: true, privacy: privacy('private') });
    await done;
  });

  it('a read from the old gateway cannot settle the new one, and sending waits for the new one', async () => {
    const { reloadPrivacyForNewGateway, getPrivacySwitchState, privacyResource, shownMode } = await setup();
    const answers: Array<(value: { ok: boolean; privacy: GatewayPrivacy }) => void> = [];
    (window as unknown as { antseedDesktop: { gatewayGetPrivacy: unknown } }).antseedDesktop.gatewayGetPrivacy = () => new Promise((resolve) => answers.push(resolve));
    void privacyResource.refresh();
    const reloading = reloadPrivacyForNewGateway();
    expect(getPrivacySwitchState().switching).toBe(true);
    answers[1]!({ ok: true, privacy: privacy('anonymous') });
    await reloading;
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: null });
    answers[0]!({ ok: true, privacy: privacy('private') });
    await tick();
    expect(shownMode()).toBe('anonymous');
  });

  it('a write still on its way to the old gateway cannot settle the new one', async () => {
    const { requestPrivacyMode, reloadPrivacyForNewGateway, getPrivacySwitchState, calls, shownMode } = await setup();
    const writing = requestPrivacyMode('private');
    await reloadPrivacyForNewGateway();
    expect(shownMode()).toBe('anonymous');
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: null });
    calls[0].settle({ ok: true, privacy: privacy('private') });
    await writing;
    expect(shownMode()).toBe('anonymous');
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: null });
  });

  it('keeps sending held when the new gateway cannot be read', async () => {
    const { reloadPrivacyForNewGateway, getPrivacySwitchState } = await setup();
    const stubbed = window as unknown as { antseedDesktop: { gatewayGetPrivacy: unknown }; setTimeout: unknown };
    stubbed.antseedDesktop.gatewayGetPrivacy = async () => ({ ok: false, error: 'down' });
    stubbed.setTimeout = () => 0;
    await reloadPrivacyForNewGateway();
    expect(getPrivacySwitchState().switching).toBe(true);
    expect(getPrivacySwitchState().error).toMatch(/privacy mode/);
  });

  it('an older reload can neither release sending early nor hold it again', async () => {
    const { reloadPrivacyForNewGateway, getPrivacySwitchState } = await setup();
    const answers: Array<(value: { ok: boolean; privacy?: GatewayPrivacy; error?: string }) => void> = [];
    (window as unknown as { antseedDesktop: { gatewayGetPrivacy: unknown } }).antseedDesktop.gatewayGetPrivacy = () => new Promise((resolve) => answers.push(resolve));
    const older = reloadPrivacyForNewGateway();
    const newer = reloadPrivacyForNewGateway();
    answers[0]!({ ok: true, privacy: privacy('anonymous') });
    await older;
    expect(getPrivacySwitchState().switching).toBe(true);
    answers[1]!({ ok: true, privacy: privacy('anonymous') });
    await newer;
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: null });

    const olderFails = reloadPrivacyForNewGateway();
    const newest = reloadPrivacyForNewGateway();
    answers[3]!({ ok: true, privacy: privacy('anonymous') });
    await newest;
    answers[2]!({ ok: false, error: 'down' });
    await olderFails;
    expect(getPrivacySwitchState()).toEqual({ switching: false, error: null });
  });
});
