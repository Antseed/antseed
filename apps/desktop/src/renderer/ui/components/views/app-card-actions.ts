/**
 * On Windows, a tool installed only inside WSL isn't seen until the first
 * connect looks for it there, so Connect stays on offer for a tool that seems
 * missing. Connecting reports clearly if it isn't anywhere.
 */
export function offersConnectAnyway(platform: string | undefined): boolean {
  return platform === 'win32';
}
