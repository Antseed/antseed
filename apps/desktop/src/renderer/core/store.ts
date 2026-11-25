import type { RendererUiState } from './state';

type Listener = () => void;

let listeners: Listener[] = [];
let stateRef: RendererUiState | null = null;
let notifyPending = false;

function emitListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function initStore(state: RendererUiState): void {
  stateRef = state;
}

export function notifyUiStateChanged(): void {
  if (!notifyPending) {
    notifyPending = true;
    setTimeout(() => {
      notifyPending = false;
      emitListeners();
    }, 0);
  }
}

export function notifyUiStateChangedSync(): void {
  if (notifyPending) {
    notifyPending = false;
  }
  emitListeners();
}

export function subscribe(listener: Listener): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function getUiStateRef(): RendererUiState {
  if (!stateRef) {
    throw new Error('Store not initialized — call initStore() before rendering');
  }
  return stateRef;
}
