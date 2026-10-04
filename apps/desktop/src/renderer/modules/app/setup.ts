import type { RendererUiState } from '../../core/state';
import { notifyUiStateChanged } from '../../core/store';
import type { DesktopBridge } from '../../types/bridge';

type AppSetupModuleOptions = {
  uiState: RendererUiState;
  bridge: DesktopBridge | null;
};

export function initAppSetupModule({ uiState, bridge }: AppSetupModuleOptions) {
  if (!bridge) return;

  // Query initial status. Three cases:
  // - needed:false → plugin already installed before this launch, skip setup screen.
  // - needed:true, complete:false → install in progress, wait for onAppSetupComplete.
  // - needed:true, complete:true → install finished before renderer loaded (fast bundle
  //   copy), app:setup-complete event was missed — start connect immediately.
  void bridge.getAppSetupStatus?.().then((status) => {
    uiState.appSetupNeeded = status.needed;
    uiState.appSetupComplete = status.complete;
    uiState.appSetupStatusKnown = true;
    notifyUiStateChanged();

    if (status.needed && status.complete) {
      void bridge.start?.({ mode: 'connect', router: 'local' }).catch(() => {});
    }
  });

  const unsubStep = bridge.onAppSetupStep?.((data) => {
    uiState.appSetupStep = data.label;
    notifyUiStateChanged();
  });

  const unsubComplete = bridge.onAppSetupComplete?.(() => {
    uiState.appSetupComplete = true;
    notifyUiStateChanged();

    // Auto-start connect so the setup screen can show DHT/peer/service progress.
    void bridge.start?.({
      mode: 'connect',
      router: 'local',
    }).catch(() => {
      // Error is handled / logged by the runtime module.
    });
  });

  return () => {
    unsubStep?.();
    unsubComplete?.();
  };
}
