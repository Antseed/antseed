import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ReminderState, ReminderVariant, VprModelCatalogEntry } from '../../core/state';
import { createInitialUiState } from '../../core/state';
import type { DesktopBridge, DesktopPaymentChannelSummary } from '../../types/bridge';
import type { OpenRouterReferenceMap } from '../catalog/openrouter-baseline';
import {
  computeProspectiveUsd,
  computeRetrospectiveUsd,
  initReminderModule,
  mergeCounters,
} from './reminder';

const INSTALL_DATE_KEY = 'antseed.desktop.reminder.installDate';
const INSTALLED_AT_KEY = 'antseed.desktop.reminder.installedAt';
const STATE_KEY = 'antseed.desktop.reminder.state';
const COUNTERS_KEY = 'antseed.desktop.reminder.counters';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function catalogEntry(overrides: Partial<VprModelCatalogEntry> = {}): VprModelCatalogEntry {
  return {
    provider: 'openai',
    serviceId: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    peerCount: 1,
    categories: [],
    minInputUsdPerMillion: 5,
    maxInputUsdPerMillion: 5,
    minOutputUsdPerMillion: 15,
    maxOutputUsdPerMillion: 15,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    expectedSavingsPct: null,
    hasEligibleFreeSeller: true,
    bestPeerId: 'peer',
    ...overrides,
  };
}

const referenceMap: OpenRouterReferenceMap = {
  gpt56sol: { input: 10, output: 30 },
};

function makeEligibleState() {
  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conversation-1';
  uiState.chatConversationsLoaded = true;
  uiState.chatConversations = [
    { id: 'conversation-1', messageCount: 6 },
    { id: 'conversation-2', messageCount: 2 },
  ];
  uiState.chatMessages = [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'user', content: 'three' },
  ];
  uiState.vprModelCatalog = [catalogEntry()];
  return uiState;
}

function setLifetimeUsage(uiState: ReturnType<typeof createInitialUiState>, requests = 7): void {
  uiState.creditsBuyerUsage = {
    totalRequests: requests,
    totalInputTokens: '20000',
    totalOutputTokens: '20000',
    totalSettlements: 0,
    uniqueSellers: 1,
    services: [{
      serviceIdHash: 'hash',
      serviceName: 'gpt-5.6-sol',
      amountUsdc: '0',
      inputTokens: '20000',
      cachedInputTokens: '0',
      outputTokens: '20000',
      requestCount: requests,
    }],
  };
}

function primeD1(
  storage: MemoryStorage,
  now: number,
  overrides: Partial<{ requests: number; inputTokens: number; outputTokens: number }> = {},
): void {
  const requests = overrides.requests ?? 14;
  const inputTokens = overrides.inputTokens ?? 14_000;
  const outputTokens = overrides.outputTokens ?? 14_000;
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now - 31 * 60_000));
  storage.setItem(COUNTERS_KEY, JSON.stringify({
    lifetimeRequests: requests,
    summariesSeeded: true,
    days: {
      [localDay(now)]: {
        requests,
        inputTokens,
        outputTokens,
        services: {},
      },
    },
  }));
}

function primeReminder(
  storage: MemoryStorage,
  now: number,
  state: ReminderState,
  ageDays: number,
  lifetimeRequests = 7,
): void {
  storage.setItem(INSTALL_DATE_KEY, localDay(now - ageDays * 86_400_000));
  storage.setItem(INSTALLED_AT_KEY, String(now - ageDays * 86_400_000));
  storage.setItem(STATE_KEY, state);
  storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests, summariesSeeded: true, days: {} }));
}

function paymentChannel(): DesktopPaymentChannelSummary {
  return {
    channelId: 'channel-1',
    peerId: 'peer-1',
    seller: '0xseller',
    reserveMax: '1',
    cumulativeSigned: '0',
    settledUsdc: '0',
    reservedAt: 1,
    status: 'open',
    requestCount: 0,
    inputTokens: '0',
    outputTokens: '0',
    cooperativeCloseSupported: true,
  };
}

function offer(variant: ReminderVariant) {
  return {
    variant,
    requestsCount: 10,
    retrospectiveUsd: '1.00',
    prospectiveUsd: '20.00',
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test('prospective value uses median discount and guards weak offers', () => {
  const strong = computeProspectiveUsd([catalogEntry()], referenceMap);
  assert.ok(strong);
  assert.equal(strong.discount, 0.5);
  assert.equal(strong.prospectiveUsd, 20);

  const weak = computeProspectiveUsd([
    catalogEntry({ minInputUsdPerMillion: 9, minOutputUsdPerMillion: 27 }),
  ], referenceMap);
  assert.equal(weak, null);
});

test('retrospective value prices matched and unmatched usage', () => {
  const exact = computeRetrospectiveUsd({
    services: [{ serviceName: 'gpt-5.6-sol', inputTokens: 10_000, outputTokens: 20_000 }],
    totalInputTokens: 10_000,
    totalOutputTokens: 20_000,
    catalog: [catalogEntry()],
    referenceMap,
  });
  const blended = computeRetrospectiveUsd({
    services: [],
    totalInputTokens: 10_000,
    totalOutputTokens: 20_000,
    catalog: [catalogEntry()],
    referenceMap,
  });
  assert.equal(exact, 0.7);
  assert.equal(blended, 0.7);
});

test('Claude-family usage matches canonical OpenRouter reference keys', () => {
  const map: OpenRouterReferenceMap = {
    fable5: { input: 5, output: 30 },
  };
  const value = computeRetrospectiveUsd({
    services: [{ serviceName: 'claude-fable-5', inputTokens: 1_000_000, outputTokens: 1_000_000 }],
    totalInputTokens: 1_000_000,
    totalOutputTokens: 1_000_000,
    catalog: [catalogEntry({ serviceId: 'fable-5', label: 'Claude Fable 5' })],
    referenceMap: map,
  });

  assert.equal(value, 35);
});

test('prospective value rounds to the nearest fifty cents', () => {
  const result = computeProspectiveUsd([
    catalogEntry({ minInputUsdPerMillion: 7, minOutputUsdPerMillion: 21 }),
  ], referenceMap);
  assert.ok(result);
  assert.equal(result.prospectiveUsd, 14.5);
});

test('prospective value treats zero-priced routes as unknown instead of a discount', () => {
  const freeInputTier = catalogEntry({
    serviceId: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    minInputUsdPerMillion: 0,
    maxInputUsdPerMillion: 0,
    minOutputUsdPerMillion: 0.2,
    maxOutputUsdPerMillion: 0.2,
  });
  const map: OpenRouterReferenceMap = {
    ...referenceMap,
    deepseekv4flash: { input: 0.14, output: 0.28 },
  };

  assert.equal(computeProspectiveUsd([freeInputTier], map), null);

  const mixed = computeProspectiveUsd([freeInputTier, catalogEntry()], map);
  assert.ok(mixed);
  assert.equal(mixed.discount, 0.5);
  assert.equal(mixed.prospectiveUsd, 20);
});

test('D1 publishes the Home offer directly after a qualifying response', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primeD1(storage, now);
  const uiState = makeEligibleState();
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();

  assert.equal(uiState.reminderState, 'armed_d1');
  assert.equal(uiState.reminderOffer?.variant, 'd1');
  assert.equal(uiState.reminderOffer?.requestsCount, 15);

  module.onResponseCompleted('conversation-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();
  assert.equal(uiState.reminderOffer?.requestsCount, 15);
});

test('D1 remains hidden until the 30-minute warmup elapses', async () => {
  const installTime = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(installTime));
  storage.setItem(INSTALLED_AT_KEY, String(installTime));
  const uiState = makeEligibleState();
  let currentTime = installTime;
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => currentTime,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();
  assert.equal(uiState.reminderOffer, null);

  currentTime = installTime + 30 * 60_000;
  module.onResponseCompleted('conversation-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();
  assert.equal(uiState.reminderOffer?.variant, 'd1');
});

test('D1 suppresses the offer when any usage or conversation gate is missing', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  for (const item of [
    {
      name: 'too few conversations',
      configure(storage: MemoryStorage, uiState: ReturnType<typeof makeEligibleState>) {
        primeD1(storage, now);
        uiState.chatConversations = uiState.chatConversations.slice(0, 1);
      },
      conversationId: 'conversation-1',
      usage: { inputTokens: 500_000, outputTokens: 500_000, service: 'gpt-5.6-sol' },
    },
    {
      name: 'too few visible turns',
      configure(storage: MemoryStorage, uiState: ReturnType<typeof makeEligibleState>) {
        primeD1(storage, now);
        uiState.chatMessages = uiState.chatMessages.slice(0, 2);
      },
      conversationId: 'conversation-1',
      usage: { inputTokens: 500_000, outputTokens: 500_000, service: 'gpt-5.6-sol' },
    },
    {
      name: 'completion is not for the active conversation',
      configure(storage: MemoryStorage) {
        primeD1(storage, now);
      },
      conversationId: 'conversation-2',
      usage: { inputTokens: 500_000, outputTokens: 500_000, service: 'gpt-5.6-sol' },
    },
    {
      name: 'both request and output thresholds are below minimum',
      configure(storage: MemoryStorage) {
        primeD1(storage, now, { requests: 13, outputTokens: 1_000 });
      },
      conversationId: 'conversation-1',
      usage: { inputTokens: 1, outputTokens: 1, service: 'gpt-5.6-sol' },
    },
  ] as const) {
    const storage = new MemoryStorage();
    const uiState = makeEligibleState();
    item.configure(storage, uiState);
    const module = initReminderModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted(item.conversationId, item.usage);
    await flushPromises();
    assert.equal(uiState.reminderOffer, null, item.name);
    assert.equal(uiState.reminderState, 'armed_d1', item.name);
  }
});

test('D1 request and output thresholds are independent alternatives', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  for (const item of [
    { requests: 14, outputTokens: 1_000, completionOutput: 1, name: 'request threshold' },
    { requests: 1, outputTokens: 29_999, completionOutput: 1, name: 'output threshold' },
  ]) {
    const storage = new MemoryStorage();
    primeD1(storage, now, { requests: item.requests, outputTokens: item.outputTokens });
    const uiState = makeEligibleState();
    const module = initReminderModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted('conversation-1', {
      inputTokens: 500_000,
      outputTokens: item.completionOutput,
      service: 'gpt-5.6-sol',
    });
    await flushPromises();
    assert.equal(uiState.reminderOffer?.variant, 'd1', item.name);
  }
});

test('D1 counts completions in a tool conversation that never opened in the chat view', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primeD1(storage, now);
  const uiState = makeEligibleState();
  uiState.chatActiveConversation = null;
  uiState.chatMessages = [];
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  for (let index = 0; index < 2; index += 1) {
    module.onResponseCompleted('codex-desktop:thread-1', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      service: 'gpt-5.6-sol',
    });
    await flushPromises();
    assert.equal(uiState.reminderOffer, null);
  }

  module.onResponseCompleted('codex-desktop:thread-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();
  assert.equal(uiState.reminderOffer?.variant, 'd1');
});

test('D1 retrospective falls back to lifetime usage when daily counters carry no tokens', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primeD1(storage, now, { requests: 25, inputTokens: 0, outputTokens: 0 });
  const uiState = makeEligibleState();
  setLifetimeUsage(uiState, 25);
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', {
    inputTokens: 0,
    outputTokens: 0,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();
  assert.equal(uiState.reminderOffer?.variant, 'd1');
  assert.notEqual(uiState.reminderOffer?.retrospectiveUsd, '');
});

test('later reminders remain hidden until retrospective usage can be priced', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primeReminder(storage, now, 'armed_d2', 1, 8);
  const uiState = makeEligibleState();
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', {
    inputTokens: 0,
    outputTokens: 0,
    service: null,
  });
  await flushPromises();

  assert.equal(uiState.reminderOffer, null);
  assert.equal(uiState.reminderState, 'armed_d2');
});

test('persistCounters never lowers already-persisted totals', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const day = localDay(now);
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, day);
  storage.setItem(INSTALLED_AT_KEY, String(now));
  storage.setItem(STATE_KEY, 'armed_d1');
  const seed = {
    lifetimeRequests: 5,
    summariesSeeded: true,
    days: {
      [day]: {
        requests: 5,
        inputTokens: 100_000,
        outputTokens: 1_000,
        services: { deepseekv4flash: { inputTokens: 100_000, outputTokens: 1_000 } },
      },
    },
  };
  storage.setItem(COUNTERS_KEY, JSON.stringify(seed));
  const uiState = makeEligibleState();
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  // Simulate a newer write from a sibling module instance that advanced the
  // totals beyond this instance's in-memory copy.
  storage.setItem(COUNTERS_KEY, JSON.stringify({
    lifetimeRequests: 25,
    summariesSeeded: true,
    days: {
      [day]: {
        requests: 25,
        inputTokens: 6_000_000,
        outputTokens: 50_000,
        services: { deepseekv4flash: { inputTokens: 6_000_000, outputTokens: 50_000 } },
      },
    },
  }));

  // This (stale) instance completes a response and tries to persist its lower
  // in-memory totals — the merge must keep the higher persisted numbers.
  module.onResponseCompleted('conversation-1', {
    inputTokens: 1000,
    outputTokens: 1000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();

  const persisted = JSON.parse(storage.getItem(COUNTERS_KEY) ?? '{}') as {
    lifetimeRequests: number;
    days: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
  };
  assert.equal(persisted.lifetimeRequests, 25);
  assert.equal(persisted.days[day].requests, 25);
  assert.equal(persisted.days[day].inputTokens, 6_000_000);
  assert.equal(persisted.days[day].outputTokens, 50_000);
});

test('mergeCounters keeps the higher totals per day and service', () => {
  const day = '2026-08-11';
  const higher = {
    lifetimeRequests: 25,
    summariesSeeded: true,
    days: {
      [day]: {
        requests: 25,
        inputTokens: 6_000_000,
        outputTokens: 50_000,
        services: {
          deepseekv4flash: { inputTokens: 6_000_000, outputTokens: 50_000 },
          gpt56sol: { inputTokens: 100, outputTokens: 200 },
        },
      },
    },
  };
  const lower = {
    lifetimeRequests: 3,
    summariesSeeded: false,
    days: {
      [day]: {
        requests: 3,
        inputTokens: 0,
        outputTokens: 0,
        services: { deepseekv4flash: { inputTokens: 0, outputTokens: 0 } },
      },
      '2026-08-10': {
        requests: 5,
        inputTokens: 1,
        outputTokens: 2,
        services: {},
      },
    },
  };

  const merged = mergeCounters(higher, lower);
  assert.equal(merged.lifetimeRequests, 25);
  assert.equal(merged.days[day].requests, 25);
  assert.equal(merged.days[day].inputTokens, 6_000_000);
  assert.equal(merged.days[day].services.deepseekv4flash.inputTokens, 6_000_000);
  assert.equal(merged.days[day].services.gpt56sol.inputTokens, 100);
  assert.equal(merged.days['2026-08-10'].requests, 5);
});

test('day rollover lazily arms D2 and uses the lower lifetime threshold', async () => {
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now - 86_400_000));
  storage.setItem(INSTALLED_AT_KEY, String(now - 86_400_000));
  storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 7, summariesSeeded: true, days: {} }));
  const uiState = makeEligibleState();
  setLifetimeUsage(uiState);
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(uiState.reminderState, 'armed_d2');
  assert.equal(uiState.reminderOffer?.variant, 'd2');
});

test('active returns advance every prior state to the latest due milestone', async () => {
  const now = new Date(2026, 7, 20, 12, 0, 0).getTime();
  for (const item of [
    { initial: 'armed_d1', ageDays: 4, expectedState: 'armed_d5', expectedVariant: 'd5' },
    { initial: 'armed_d2', ageDays: 6, expectedState: 'armed_d5', expectedVariant: 'd5' },
    { initial: 'armed_d1', ageDays: 14, expectedState: 'armed_d15', expectedVariant: 'd15' },
    { initial: 'armed_d2', ageDays: 16, expectedState: 'armed_d15', expectedVariant: 'd15' },
    { initial: 'armed_d5', ageDays: 16, expectedState: 'armed_d15', expectedVariant: 'd15' },
  ] as const) {
    const storage = new MemoryStorage();
    primeReminder(storage, now, item.initial, item.ageDays);
    const uiState = makeEligibleState();
    setLifetimeUsage(uiState);
    const module = initReminderModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
    await flushPromises();
    assert.equal(uiState.reminderState, item.expectedState, `${item.initial} at day ${item.ageDays}`);
    assert.equal(uiState.reminderOffer?.variant, item.expectedVariant, `${item.initial} at day ${item.ageDays}`);
  }
});

test('day 5 and day 15 reminders wait for activity at their milestones', async () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  for (const item of [
    { state: 'armed_d5', variant: 'd5', ageDays: 4 },
    { state: 'armed_d15', variant: 'd15', ageDays: 14 },
  ] as const) {
    const storage = new MemoryStorage();
    storage.setItem(INSTALL_DATE_KEY, localDay(now - item.ageDays * 86_400_000));
    storage.setItem(INSTALLED_AT_KEY, String(now - item.ageDays * 86_400_000));
    storage.setItem(STATE_KEY, item.state);
    storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 7, summariesSeeded: true, days: {} }));
    const uiState = makeEligibleState();
    setLifetimeUsage(uiState);
    const module = initReminderModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
    await flushPromises();
    assert.equal(uiState.reminderOffer?.variant, item.variant);
  }
});

test('day 5 reminder does not show early', async () => {
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now));
  storage.setItem(STATE_KEY, 'armed_d5');
  storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 20, summariesSeeded: true, days: {} }));
  const uiState = makeEligibleState();
  setLifetimeUsage(uiState, 20);
  const module = initReminderModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(uiState.reminderOffer, null);
  assert.equal(uiState.reminderState, 'armed_d5');
});

test('later reminders require lifetime usage, daily activity, and their milestone date', async () => {
  const now = new Date(2026, 7, 20, 12, 0, 0).getTime();

  const insufficientStorage = new MemoryStorage();
  primeReminder(insufficientStorage, now, 'armed_d2', 1, 6);
  const insufficientState = makeEligibleState();
  setLifetimeUsage(insufficientState, 6);
  const insufficientModule = initReminderModule({
    uiState: insufficientState,
    dependencies: {
      storage: insufficientStorage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  insufficientModule.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(insufficientState.reminderOffer, null);
  assert.equal(insufficientState.reminderState, 'armed_d2');

  const inactiveStorage = new MemoryStorage();
  primeReminder(inactiveStorage, now, 'armed_d5', 6);
  const inactiveState = makeEligibleState();
  setLifetimeUsage(inactiveState);
  initReminderModule({
    uiState: inactiveState,
    dependencies: {
      storage: inactiveStorage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  await flushPromises();
  assert.equal(inactiveState.reminderOffer, null);
  assert.equal(inactiveState.reminderState, 'armed_d5');

  const earlyD15Storage = new MemoryStorage();
  primeReminder(earlyD15Storage, now, 'armed_d15', 13, 20);
  const earlyD15State = makeEligibleState();
  setLifetimeUsage(earlyD15State, 20);
  const earlyD15Module = initReminderModule({
    uiState: earlyD15State,
    dependencies: {
      storage: earlyD15Storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  earlyD15Module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(earlyD15State.reminderOffer, null);
  assert.equal(earlyD15State.reminderState, 'armed_d15');
});

test('dismissing each offer advances to the next reminder', async () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  for (const item of [
    { state: 'armed_d2', variant: 'd2', ageDays: 1, expected: 'armed_d5' },
    { state: 'armed_d5', variant: 'd5', ageDays: 4, expected: 'armed_d15' },
    { state: 'armed_d15', variant: 'd15', ageDays: 14, expected: 'done' },
  ] as const) {
    const storage = new MemoryStorage();
    storage.setItem(INSTALL_DATE_KEY, localDay(now - item.ageDays * 86_400_000));
    storage.setItem(INSTALLED_AT_KEY, String(now - item.ageDays * 86_400_000));
    storage.setItem(STATE_KEY, item.state);
    storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 7, summariesSeeded: true, days: {} }));
    const uiState = makeEligibleState();
    setLifetimeUsage(uiState);
    const module = initReminderModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
    await flushPromises();
    assert.equal(uiState.reminderOffer?.variant, item.variant);
    module.dismissHome();
    assert.equal(uiState.reminderState, item.expected);
    assert.equal(uiState.reminderOffer, null);
  }
});

test('dismissing D1 advances directly to day 5', () => {
  const storage = new MemoryStorage();
  const uiState = createInitialUiState();
  uiState.reminderOffer = offer('d1');
  const module = initReminderModule({
    uiState,
    dependencies: { storage, notifyChanged: () => {} },
  });

  module.dismissHome();
  assert.equal(uiState.reminderState, 'armed_d5');
  assert.equal(storage.getItem(STATE_KEY), 'armed_d5');
  assert.equal(uiState.reminderOffer, null);
});

test('every payer source suppresses an otherwise eligible offer', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  for (const item of [
    {
      name: 'owned wallet or deposit balance',
      configure(uiState: ReturnType<typeof makeEligibleState>) {
        uiState.creditsTotalOwnedUsdc = '1';
      },
      bridge: undefined,
    },
    {
      name: 'channel already loaded in renderer state',
      configure(uiState: ReturnType<typeof makeEligibleState>) {
        uiState.creditsChannels = [paymentChannel()];
      },
      bridge: undefined,
    },
    {
      name: 'channel returned by the payment bridge',
      configure() {},
      bridge: {
        paymentsGetChannels: async () => ({ ok: true, data: [paymentChannel()], error: null }),
      } as DesktopBridge,
    },
  ] as const) {
    const storage = new MemoryStorage();
    primeD1(storage, now);
    const uiState = makeEligibleState();
    item.configure(uiState);
    const module = initReminderModule({
      bridge: item.bridge,
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted('conversation-1', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      service: 'gpt-5.6-sol',
    });
    await flushPromises();
    assert.equal(uiState.reminderOffer, null, item.name);
    assert.equal(uiState.reminderState, 'done', item.name);
    assert.equal(storage.getItem(STATE_KEY), 'done', item.name);
  }
});

test('a confirmed deposit retires and clears offers from every lifecycle state', async () => {
  for (const item of [
    { state: 'armed_d1', variant: 'd1' },
    { state: 'armed_d2', variant: 'd2' },
    { state: 'armed_d5', variant: 'd5' },
    { state: 'armed_d15', variant: 'd15' },
  ] as const) {
    const storage = new MemoryStorage();
    storage.setItem(STATE_KEY, item.state);
    const uiState = createInitialUiState();
    const module = initReminderModule({
      uiState,
      dependencies: { storage, notifyChanged: () => {} },
    });
    uiState.reminderOffer = offer(item.variant);
    uiState.creditsTotalOwnedUsdc = '1';

    await module.reconcilePayer();
    assert.equal(uiState.reminderState, 'done', item.state);
    assert.equal(storage.getItem(STATE_KEY), 'done', item.state);
    assert.equal(uiState.reminderOffer, null, item.state);
  }
});

test('failed channel lookup suppresses temporarily without advancing state', async () => {
  const now = new Date(2026, 7, 20, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primeReminder(storage, now, 'armed_d2', 6);
  const uiState = makeEligibleState();
  setLifetimeUsage(uiState);
  let lookupCount = 0;
  const bridge = {
    paymentsGetChannels: async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? { ok: false, data: [], error: 'temporarily unavailable' }
        : { ok: true, data: [], error: null };
    },
  } as DesktopBridge;
  const module = initReminderModule({
    bridge,
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(uiState.reminderState, 'armed_d2');
  assert.equal(storage.getItem(STATE_KEY), 'armed_d2');
  assert.equal(uiState.reminderOffer, null);

  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(uiState.reminderState, 'armed_d5');
  assert.equal(uiState.reminderOffer?.variant, 'd5');
});

test('storage failures hide the feature', () => {
  const failedState = createInitialUiState();
  initReminderModule({
    uiState: failedState,
    dependencies: {
      storage: {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
      },
      notifyChanged: () => {},
    },
  });
  assert.equal(failedState.reminderOffer, null);
});

test('fresh installs start at D1 while existing profiles are grandfathered to D2', () => {
  const freshState = createInitialUiState();
  initReminderModule({
    uiState: freshState,
    dependencies: { storage: new MemoryStorage(), notifyChanged: () => {} },
  });
  assert.equal(freshState.reminderState, 'armed_d1');

  const existingStorage = new MemoryStorage();
  existingStorage.setItem('antseed.desktop.vpr.hasChats', '1');
  const existingState = createInitialUiState();
  initReminderModule({
    uiState: existingState,
    dependencies: { storage: existingStorage, notifyChanged: () => {} },
  });
  assert.equal(existingState.reminderState, 'armed_d2');
});
