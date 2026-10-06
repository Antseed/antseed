// Window size preset per renderer view, shared between the main process
// (which resizes the window when the view changes) and the renderer's view
// registry test (which asserts every view is covered). Keyed by plain string
// because ViewName lives in renderer-only code; the registry test enforces
// that the keys stay in sync with VIEW_NAMES.
export type WindowSizePresetName = 'standard' | 'compact';

export const VIEW_WINDOW_PRESETS = {
  // AI VPN screens are small single-purpose panels.
  home: 'compact',
  explore: 'compact',
  model: 'compact',
  tools: 'compact',
  tunnels: 'compact',
  chats: 'compact',
  preferences: 'compact',
  credits: 'compact',
  deposit: 'compact',
  activity: 'compact',
  rewards: 'compact',
  help: 'compact',
  // Chat's base preset is the thin panel, but the view opens wide by default:
  // chatPanelExpanded starts true, and AppShell applies the standard preset
  // whenever it is set — the in-view toggle collapses back to this.
  chat: 'compact',
  // Diagnostic screens stay in the same compact panel as the AI VPN views
  // (they're reachable from Help & Support) — their tables and panels scroll
  // within the window instead of blowing it up to the wide preset.
  peers: 'compact',
  connection: 'compact',
  desktop: 'compact',
  config: 'compact',
} as const satisfies Record<string, WindowSizePresetName>;

export function windowPresetForView(view: string): WindowSizePresetName {
  return (VIEW_WINDOW_PRESETS as Record<string, WindowSizePresetName>)[view] ?? 'standard';
}
