import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Built-in "Connected apps" catalog for the AI VPN Connected apps screen.
 *
 * These are open-source tools with natively configurable API endpoints, so
 * they can ship publicly with the app and show by default — no MITM proxy or
 * private profile list required. Entries use the same raw profile JSON shape
 * as the packaged/env profile list (see apps/cli/src/system-proxy/profiles.ts).
 *
 * Merge rules: an entry in the packaged/env profile list with the same `name`
 * replaces the default here, so releases can still tweak or extend the
 * catalog; user-added custom apps (the desktop's connected-apps/custom.ts) merge in separately.
 */

/**
 * Per-platform config path for tools that follow Windows conventions instead
 * of `~/.config`. `~/`-style paths expand against homedir() everywhere, which
 * is right for home-rooted tools (codex `~/.codex`, pi `~/.pi`, opencode
 * `~/.config/opencode` — verified home-based even on Windows) but wrong for
 * tools whose Windows builds read from the known folders. Resolved here, at
 * definition time, so the patcher keeps a single path string per profile.
 */
export function platformConfigPath(
  posixPath: string,
  windowsFolder: { base: 'APPDATA' | 'LOCALAPPDATA'; segments: readonly string[] } | null,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32' || !windowsFolder) return posixPath;
  const fallback = windowsFolder.base === 'APPDATA' ? ['AppData', 'Roaming'] : ['AppData', 'Local'];
  const root = env[windowsFolder.base] || path.join(homedir(), ...fallback);
  return path.join(root, ...windowsFolder.segments);
}

export const DEFAULT_APP_PROFILES: readonly Record<string, unknown>[] = [
  {
    name: 'opencode',
    displayName: 'OpenCode',
    kind: 'config-patch',
    method: 'Config patch',
    // Client names this tool stamps on its requests (User-Agent product /
    // session-header slug) — how conversations are attributed to the app.
    toolSlugs: ['opencode'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'opencode',
      configPath: '~/.config/opencode/opencode.jsonc',
      providerKey: 'antseed',
      npm: '@ai-sdk/openai-compatible',
      providerName: 'Antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
      // Patch actual installations (native and, on Windows, WSL distros)
      // instead of blindly writing the one path above; fail the connect when
      // the tool is found nowhere. Set on every built-in CLI tool below;
      // see applyWithInstallProbe.
      installProbe: 'opencode',
    },
  },
  {
    name: 'codex',
    displayName: 'Codex',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['codex'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'codex',
      configPath: '~/.codex/config.toml',
      providerKey: 'antseed',
      providerName: 'Antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
      installProbe: 'codex',
    },
  },
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['claude-code'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'claude-code',
      configPath: '~/.claude/settings.json',
      providerKey: 'antseed',
      baseURL: 'http://localhost:{buyerPort}',
      installProbe: 'claude',
    },
  },
  {
    name: 'claude-desktop',
    displayName: 'Claude',
    kind: 'config-patch',
    method: 'Config patch',
    // The gateway stamps every forwarded request with the claude-desktop
    // source marker, so this exact slug is the whole identity. No generic
    // 'claude' entry: it would prefix-match t3code's claude-code/claude-cli
    // sessions and steal them in first-match-wins attribution.
    toolSlugs: ['claude-desktop'],
    domains: [],
    pathPrefixes: [],
    // 'open-tool' opens Claude after connect even when it was not running
    // (restartAppName is both the restart target for a running Claude and
    // the open-tool launch fallback).
    appAction: 'open-tool',
    restartAppName: 'Claude',
    configPatch: {
      format: 'claude-desktop',
      // Claude's normal-profile config: the patch flips deploymentMode to
      // "3p" here, which makes Claude boot against the Claude-3p profile
      // directory below, where the Antseed gateway profile is written.
      // Windows paths are NOT resolved here — Claude has several install
      // layouts there (classic, MSIX, Nest), so claudeDesktopPatchTargets
      // derives its own candidate roots on win32 and these apply elsewhere.
      configPath: '~/Library/Application Support/Claude/claude_desktop_config.json',
      thirdPartyDir: '~/Library/Application Support/Claude-3p',
      // Claude talks to the desktop's local Claude gateway (Anthropic-native
      // model catalog + forwarding to the buyer proxy), not the buyer proxy
      // directly — see apps/desktop/src/main/connected-apps/claude-desktop-gateway.ts.
      baseURL: 'http://127.0.0.1:{claudeGatewayPort}',
    },
  },
  {
    name: 'hermes',
    displayName: 'Hermes Agent',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['hermes', 'hermes-agent'],
    domains: [],
    pathPrefixes: [],
    appAction: 'open-tool',
    toolName: 'hermes',
    restartAppName: 'Hermes',
    configPatch: {
      format: 'hermes',
      configPath: '~/.hermes/config.yaml',
      providerKey: 'antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    },
  },
  {
    name: 'droid',
    displayName: 'Droid',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['droid'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'droid',
      // Droid CLI and Factory Desktop share this live-reloaded user config.
      configPath: '~/.factory/settings.json',
      providerKey: 'antseed',
      providerName: 'Antseed Auto',
      baseURL: 'http://localhost:{buyerPort}/v1',
      originator: 'droid',
      installProbe: 'droid',
    },
  },
  {
    name: 't3code',
    displayName: 'T3 Code',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['t3code'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 't3code',
      configPath: '~/.t3/userdata/settings.json',
      providerKey: 'antseed',
      providerName: 'Antseed',
      baseURL: 'http://localhost:{buyerPort}',
    },
  },
  {
    name: 'pi',
    displayName: 'pi',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['pi'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'pi',
      configPath: '~/.pi/agent/models.json',
      settingsPath: '~/.pi/agent/settings.json',
      providerKey: 'antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
      // Pi's OpenAI Responses transport includes prompt_cache_key with the
      // Pi session id. The buyer proxy uses that as the conversation key so
      // Pi chats show up in AI VPN Recent Chats.
      api: 'openai-responses',
      originator: 'pi',
      installProbe: 'pi',
    },
  },
  {
    name: 'gooeypi',
    displayName: 'GooeyPi',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['gooeypi'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'pi',
      configPath: '~/.pi/agent/models.json',
      settingsPath: '~/.pi/agent/settings.json',
      providerKey: 'antseed-gooeypi',
      baseURL: 'http://localhost:{buyerPort}/v1',
      api: 'openai-responses',
      originator: 'gooeypi',
    },
  },
  {
    name: 'prime-agent',
    displayName: 'Prime Agent',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['prime-agent'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      // Prime Agent reads pi's models.json/settings.json schema from
      // ~/.prime/agent on every platform. Its session engine does not pass
      // the session id to the transport (no prompt_cache_key), so the buyer
      // proxy keys chats from the originator header plus a synthetic
      // first-turn key.
      format: 'pi',
      configPath: '~/.prime/agent/models.json',
      settingsPath: '~/.prime/agent/settings.json',
      providerKey: 'antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
      api: 'openai-responses',
      originator: 'prime-agent',
      installProbe: 'prime-agent',
    },
  },
  {
    name: 'crush',
    displayName: 'Crush',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['crush'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'crush',
      // Windows: crush (charm) resolves its global config under LOCALAPPDATA.
      configPath: platformConfigPath('~/.config/crush/crush.json', {
        base: 'LOCALAPPDATA',
        segments: ['crush', 'crush.json'],
      }),
      // WSL installs read the XDG path regardless of the Windows resolution.
      wslConfigPath: '~/.config/crush/crush.json',
      providerKey: 'antseed',
      providerName: 'Antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
      installProbe: 'crush',
    },
  },
  {
    name: 'goose',
    displayName: 'Goose',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['goose'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'goose',
      // Windows: goose reads %APPDATA%\Block\goose\config\config.yaml.
      configPath: platformConfigPath('~/.config/goose/config.yaml', {
        base: 'APPDATA',
        segments: ['Block', 'goose', 'config', 'config.yaml'],
      }),
      // WSL installs read the XDG path regardless of the Windows resolution.
      wslConfigPath: '~/.config/goose/config.yaml',
      // goose provider engine; the host root is patched to the buyer proxy.
      providerKey: 'openai',
      baseURL: 'http://localhost:{buyerPort}',
      installProbe: 'goose',
    },
  },
  {
    name: 'zed',
    displayName: 'Zed',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['zed'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'zed',
      // Windows: Zed reads %APPDATA%\Zed\settings.json.
      configPath: platformConfigPath('~/.config/zed/settings.json', {
        base: 'APPDATA',
        segments: ['Zed', 'settings.json'],
      }),
      providerKey: 'antseed',
      providerName: 'Antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    },
  },
];

/**
 * Combine the packaged/env profile list with the built-in defaults: external
 * entries keep their order and override same-name defaults; the remaining
 * defaults follow.
 */
export function mergeWithDefaultAppProfiles(external: readonly unknown[]): unknown[] {
  const externalNames = new Set(
    external
      .map((profile) => (profile && typeof profile === 'object' && !Array.isArray(profile))
        ? (profile as Record<string, unknown>)['name']
        : undefined)
      .filter((name): name is string => typeof name === 'string'),
  );
  return [
    ...external,
    ...DEFAULT_APP_PROFILES.filter((profile) => !externalNames.has(profile['name'] as string)),
  ];
}
