import type { TokenProvider, TokenProviderState } from '@antseed/provider-core';
import { OAuthTokenProvider } from '@antseed/provider-core';

const CLAUDE_CODE_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_CODE_SERVICE = 'Claude Code-credentials';

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
};

let keytarPromise: Promise<KeytarModule> | null = null;

async function getKeytar(): Promise<KeytarModule> {
  if (!keytarPromise) {
    keytarPromise = import('keytar')
      .then((mod) => (mod.default ?? mod) as KeytarModule)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to load keychain integration (keytar): ${msg}. ` +
            'Use apikey auth or rebuild keytar for the active Node architecture.'
        );
      });
  }
  return keytarPromise;
}

interface ClaudeCodeOAuthPayload {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/**
 * Reads OAuth tokens from Claude Code's macOS keychain entry.
 * On refresh failure, falls back to re-reading the keychain
 * (Claude Code may have refreshed the token itself).
 */
export class ClaudeCodeTokenProvider implements TokenProvider {
  private inner: OAuthTokenProvider | null = null;

  constructor(private readonly preferredAccount?: string) {}

  async getToken(): Promise<string> {
    if (!this.inner) {
      await this.loadFromKeychain();
    }
    if (!this.inner) {
      throw new Error('ClaudeCodeTokenProvider: failed to initialize from keychain');
    }
    try {
      return await this.inner.getToken();
    } catch {
      await this.loadFromKeychain();
      return await this.inner!.getToken();
    }
  }

  async forceRefresh(): Promise<string> {
    if (!this.inner) {
      await this.loadFromKeychain();
    }
    if (!this.inner) {
      throw new Error('ClaudeCodeTokenProvider: failed to initialize from keychain');
    }
    try {
      return await this.inner.forceRefresh();
    } catch {
      await this.loadFromKeychain();
      return await this.inner!.forceRefresh();
    }
  }

  stop(): void {
    this.inner?.stop();
  }

  getState(): TokenProviderState | null {
    return this.inner?.getState() ?? null;
  }

  private async loadFromKeychain(): Promise<void> {
    const keytar = await getKeytar();
    let raw: string | null = null;

    if (this.preferredAccount) {
      raw = await keytar.getPassword(CLAUDE_CODE_SERVICE, this.preferredAccount);
    }

    if (!raw) {
      const creds = await keytar.findCredentials(CLAUDE_CODE_SERVICE);
      if (creds.length === 0) {
        throw new Error('No Claude Code credentials found in keychain');
      }
      raw = creds[0]!.password;
    }

    let data: ClaudeCodeOAuthPayload;
    try {
      data = JSON.parse(raw) as ClaudeCodeOAuthPayload;
    } catch {
      throw new Error('Failed to parse Claude Code keychain data');
    }

    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) {
      throw new Error('Claude Code keychain entry missing OAuth tokens');
    }

    this.inner = new OAuthTokenProvider({
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt ?? Date.now() + 3600_000,
      tokenEndpoint: CLAUDE_CODE_TOKEN_ENDPOINT,
      requestEncoding: 'json',
      clientId: CLAUDE_CODE_CLIENT_ID,
    });
  }
}
