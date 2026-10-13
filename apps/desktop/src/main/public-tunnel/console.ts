/**
 * The gateway console a running tunnel publishes at <public url>/console.
 *
 * Until someone claims it the console has no owner, and the only way in is a
 * one-time setup link minted by `antseed gateway console-link`. The desktop
 * mints that link for the user and opens it in their browser, so they never
 * need the CLI for it.
 */

/** `unavailable`: no tunnel, or a tunnel started without the console. */
export type TunnelConsoleState = 'unclaimed' | 'claimed' | 'unavailable';

export type TunnelConsoleStatus = {
  state: TunnelConsoleState;
  /** <public url>/console, when the tunnel is up. */
  url: string | null;
};

/** The parts of `tunnel/tunnel.state.json` the console needs. */
export type TunnelLocation = {
  publicOrigin: string;
  gatewayPort: number;
};

type ConsoleLinkJson = { url: string; setupRequired: boolean; setupLink: string | null };

export type TunnelConsoleDependencies = {
  /** The running tunnel's public origin and local gateway port; null when no tunnel is running. */
  readLocation: () => Promise<TunnelLocation | null>;
  /** The data dir `antseed tunnel start` runs with. */
  dataDir: () => string;
  fetch: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  /** Runs an `antseed` subcommand and returns its stdout. Must not log it: it carries the setup token. */
  runCli: (args: string[]) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
};

/** Reads `publicUrl` and `gatewayPort` from the tunnel's state file contents. */
export function parseTunnelLocation(state: unknown): TunnelLocation | null {
  if (!state || typeof state !== 'object') return null;
  const raw = state as Record<string, unknown>;
  if (typeof raw.publicUrl !== 'string' || typeof raw.gatewayPort !== 'number') return null;
  try {
    const url = new URL(raw.publicUrl);
    if (url.protocol !== 'https:') return null;
    return { publicOrigin: url.origin, gatewayPort: raw.gatewayPort };
  } catch {
    return null;
  }
}

/**
 * `console-link` pointed at the tunnel's public origin: passkeys bind to the
 * hostname they are created on (WebAuthn rpID), so the owner's passkey must be
 * made on the public hostname to work remotely.
 */
export function consoleLinkArgs(dataDir: string, publicOrigin: string): string[] {
  return ['--data-dir', dataDir, 'gateway', 'console-link', '--public-url', publicOrigin, '--json'];
}

/** The JSON `console-link --json` prints (the last JSON object on stdout). */
export function parseConsoleLinkOutput(stdout: string): ConsoleLinkJson {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.startsWith('{')).pop();
  const parsed = line ? JSON.parse(line) as Record<string, unknown> : null;
  if (!parsed || typeof parsed.url !== 'string' || typeof parsed.setupRequired !== 'boolean') {
    throw new Error('Unexpected output from antseed gateway console-link.');
  }
  return {
    url: parsed.url,
    setupRequired: parsed.setupRequired,
    setupLink: typeof parsed.setupLink === 'string' ? parsed.setupLink : null,
  };
}

export function createTunnelConsole(deps: TunnelConsoleDependencies) {
  const status = async (): Promise<TunnelConsoleStatus> => {
    const location = await deps.readLocation();
    if (!location) return { state: 'unavailable', url: null };
    const url = `${location.publicOrigin}/console`;
    try {
      // The same endpoint the console's sign-in page reads.
      const response = await deps.fetch(`http://127.0.0.1:${location.gatewayPort}/console/api/auth/config`);
      if (!response.ok) return { state: 'unavailable', url };
      const config = await response.json() as { setupRequired?: unknown };
      return { state: config.setupRequired === true ? 'unclaimed' : 'claimed', url };
    } catch {
      return { state: 'unavailable', url };
    }
  };

  /** Mints a one-time setup link and opens it; when already claimed, opens the console instead. */
  const claim = async (): Promise<{ ok: boolean; status: TunnelConsoleStatus; error?: string }> => {
    const location = await deps.readLocation();
    if (!location) return { ok: false, status: { state: 'unavailable', url: null }, error: 'Start the tunnel first.' };
    try {
      const result = parseConsoleLinkOutput(await deps.runCli(consoleLinkArgs(deps.dataDir(), location.publicOrigin)));
      const link = result.setupLink ?? result.url;
      await deps.openExternal(link);
      return { ok: true, status: { state: result.setupLink ? 'unclaimed' : 'claimed', url: result.url } };
    } catch (error) {
      return { ok: false, status: await status(), error: error instanceof Error ? error.message : String(error) };
    }
  };

  return { status, claim };
}
