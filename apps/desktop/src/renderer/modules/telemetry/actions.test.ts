import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  recordUserAction,
  recordUserActionCoalesced,
  telemetrySurfaceForView,
} from './actions';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('telemetrySurfaceForView', () => {
  it('maps product views to fixed privacy-safe surfaces', () => {
    expect(telemetrySurfaceForView('home')).toBe('home');
    expect(telemetrySurfaceForView('tools')).toBe('apps');
    expect(telemetrySurfaceForView('connection')).toBe('connection');
    expect(telemetrySurfaceForView('gateway')).toBe('gateway');
  });
});

describe('user action delivery', () => {
  it('sends discrete actions immediately', () => {
    const telemetryRecordUserAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { antseedDesktop: { telemetryRecordUserAction } });

    recordUserAction('chat_send', 'chat');

    expect(telemetryRecordUserAction).toHaveBeenCalledOnce();
    expect(telemetryRecordUserAction).toHaveBeenCalledWith({ action: 'chat_send', surface: 'chat' });
  });

  it('coalesces repeated actions until the 500 ms quiet window expires', () => {
    vi.useFakeTimers();
    const telemetryRecordUserAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { antseedDesktop: { telemetryRecordUserAction } });

    recordUserActionCoalesced('routing_preferences_change', 'preferences');
    vi.advanceTimersByTime(300);
    recordUserActionCoalesced('routing_preferences_change', 'preferences');
    vi.advanceTimersByTime(499);
    expect(telemetryRecordUserAction).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(telemetryRecordUserAction).toHaveBeenCalledOnce();
    expect(telemetryRecordUserAction).toHaveBeenCalledWith({
      action: 'routing_preferences_change',
      surface: 'preferences',
    });
  });

  it('coalesces action and surface pairs independently', () => {
    vi.useFakeTimers();
    const telemetryRecordUserAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { antseedDesktop: { telemetryRecordUserAction } });

    recordUserActionCoalesced('routing_preferences_change', 'preferences');
    recordUserActionCoalesced('view_opened', 'preferences');
    vi.advanceTimersByTime(500);

    expect(telemetryRecordUserAction).toHaveBeenCalledTimes(2);
  });
});
