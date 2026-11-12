import { describe, expect, it } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { createSelectedSnapshotGetter, shallowEqual } from './useUiSelector';

describe('shallowEqual', () => {
  it('compares plain objects by key and reference value', () => {
    expect(shallowEqual({ count: 1, label: 'ready' }, { count: 1, label: 'ready' })).toBe(true);
    expect(shallowEqual({ count: 1 }, { count: 2 })).toBe(false);
    expect(shallowEqual({ count: 1 }, { count: 1, extra: true })).toBe(false);
  });

  it('does not treat arrays as shallow-equal selected objects', () => {
    expect(shallowEqual([1], [1])).toBe(false);
  });
});

describe('createSelectedSnapshotGetter', () => {
  it('reuses the selected object when unrelated state changes', () => {
    let state = createInitialUiState();
    state.chatActiveConversation = 'conv-1';
    state.ovPeers = '1';

    const getSnapshot = createSelectedSnapshotGetter(
      (current) => ({
        activeConversation: current.chatActiveConversation,
        sending: current.chatSending,
      }),
      shallowEqual,
      () => state,
    );

    const first = getSnapshot();

    state = {
      ...state,
      ovPeers: '2',
    };
    const unrelatedChange = getSnapshot();

    state = {
      ...state,
      chatSending: true,
    };
    const selectedChange = getSnapshot();

    expect(unrelatedChange).toBe(first);
    expect(selectedChange).not.toBe(first);
    expect(selectedChange).toEqual({
      activeConversation: 'conv-1',
      sending: true,
    });
  });

  it('can use stable wrappers around changing selector implementations', () => {
    let state = createInitialUiState();
    state.chatSending = false;

    let selector = (current: typeof state) => ({
      sending: current.chatSending,
    });
    let isEqual = shallowEqual<{ sending: boolean }>;

    const getSnapshot = createSelectedSnapshotGetter(
      (current) => selector(current),
      (left, right) => isEqual(left, right),
      () => state,
    );

    const first = getSnapshot();

    selector = (current) => ({
      sending: current.chatSending,
    });
    isEqual = shallowEqual;

    expect(getSnapshot()).toBe(first);

    state = {
      ...state,
      chatSending: true,
    };

    expect(getSnapshot()).toEqual({ sending: true });
  });
});
