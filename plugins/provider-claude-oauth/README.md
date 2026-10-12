# @antseed/provider-claude-oauth

> **Testing and development only.** This plugin uses OAuth credentials from a personal Claude subscription. Reselling subscription-based access violates Anthropic's Terms of Service and is not permitted. Use this plugin only for local development, testing, and demo purposes.

Third-party Anthropic Claude provider plugin with OAuth authentication for Antseed. This plugin demonstrates how a third-party developer can build, test, and publish an Antseed provider plugin using `@antseed/provider-core`.

## How to Create a Plugin

1. Create a new directory under `plugins/` (or anywhere on disk).
2. Add a `package.json` with `@antseed/provider-core` as a dependency and `@antseed/node` as a peer dependency.
3. Implement and default-export an `AntseedProviderPlugin` object from `src/index.ts`.
4. Build with `tsc` and test with `vitest`.

## Plugin Manifest Format

Every provider plugin must default-export an object satisfying `AntseedProviderPlugin`:

```typescript
import type { AntseedProviderPlugin, ConfigField } from '@antseed/node';

const plugin: AntseedProviderPlugin = {
  name: 'my-provider',           // unique plugin name
  displayName: 'My Provider',    // human-readable label
  version: '0.1.0',
  type: 'provider',
  description: 'Description of the provider',
  configSchema: [                // fields the user fills in
    { key: 'API_KEY', label: 'API Key', type: 'secret', required: true },
  ],
  createProvider(config) {
    // Return a Provider instance
  },
};
export default plugin;
```

### ConfigField Types

| Type       | Description                        |
| ---------- | ---------------------------------- |
| `string`   | Plain text input                   |
| `number`   | Numeric input                      |
| `boolean`  | Toggle / checkbox                  |
| `secret`   | Masked input (tokens, keys)        |
| `string[]` | Comma-separated list of strings    |

## Using provider-core

The `@antseed/provider-core` package provides reusable building blocks:

- **`BaseProvider`** -- Implements the `Provider` interface and wires up `HttpRelay`.
- **`StaticTokenProvider`** -- Wraps a static API key with no refresh logic.
- **`OAuthTokenProvider`** -- Manages OAuth access/refresh token pairs with automatic renewal.
- **`HttpRelay`** -- Forwards requests to an upstream API with auth header swapping, model validation, and concurrency control.

```typescript
import { BaseProvider, OAuthTokenProvider, StaticTokenProvider } from '@antseed/provider-core';
```

## Testing Locally

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests
npm test
```

To test the plugin end-to-end with a local Antseed node, link it:

```bash
cd plugins/provider-claude-oauth
npm link

cd /path/to/your/antseed-project
npm link @anthropic/provider-claude-oauth
```

Then configure the plugin in your node's plugin config with the required config fields.

## Publishing to npm

1. Ensure `package.json` has the correct `name`, `version`, and `description`.
2. Build the plugin: `npm run build`
3. Login to npm: `npm login`
4. Publish: `npm publish --access public`

For scoped packages like `@anthropic/provider-claude-oauth`, use `--access public` to publish as a public package.

## Installing via antseed plugin add

Once published, users can install the plugin:

```bash
antseed plugin add @anthropic/provider-claude-oauth
```

This will download the plugin from npm, register it with the local Antseed node, and prompt the user to configure the required fields (access token, etc.).

## Configuration Reference

| Key                            | Type     | Required | Default | Description                          |
| ------------------------------ | -------- | -------- | ------- | ------------------------------------ |
| `CLAUDE_ACCESS_TOKEN`          | secret   | Conditional | --   | Required unless an existing credential file supplies it |
| `CLAUDE_AUTH_FILE`             | string   | No       | --      | Writable development/testing OAuth credential file |
| `CLAUDE_REFRESH_TOKEN`         | secret   | No       | --      | OAuth refresh token for auto-renewal |
| `CLAUDE_TOKEN_EXPIRES_AT`      | number   | No       | --      | Epoch ms when access token expires   |
| `CLAUDE_OAUTH_CLIENT_ID`       | string   | Yes      | --      | OAuth application client ID used when refreshing tokens |
| `ANTSEED_INPUT_USD_PER_MILLION`| number   | No       | 10      | Input token price (USD per 1M)       |
| `ANTSEED_OUTPUT_USD_PER_MILLION`| number  | No       | 10      | Output token price (USD per 1M)      |
| `ANTSEED_MAX_CONCURRENCY`      | number   | No       | 5       | Max concurrent requests              |
| `ANTSEED_ALLOWED_SERVICES`     | string[] | No       | --      | Comma-separated list of service IDs  |

## Persistent authentication for development/testing

Set `CLAUDE_AUTH_FILE` to a file in a private, writable directory that survives
restarts. Create the directory beforehand, restrict its permissions, and use an
absolute path. The plugin creates credential files with mode `0600` and atomically
replaces them after refresh. Files are plaintext credentials, not encrypted storage;
keep them out of version control and protect any backups.

- On first use, supply `CLAUDE_ACCESS_TOKEN` and `CLAUDE_REFRESH_TOKEN`, plus
  `CLAUDE_TOKEN_EXPIRES_AT` (epoch milliseconds) when known. These initialize the
  file only if it does not exist.
- An existing file is authoritative, even if environment credentials differ. Its
  JSON fields are `accessToken`, `refreshToken`, and `expiresAt` (epoch milliseconds).
  Environment credentials can be removed after initialization.
- The plugin saves rotated tokens before completing refresh. If saving fails, it
  retains the new tokens in memory and retries saving rather than reverting to the
  old file. Fix storage errors before restarting: unsaved rotations cannot survive
  a process crash.
- Only one process may own/refresh a credential file and its OAuth session. This
  is not a cross-process credential synchronization mechanism.
- To repair revoked credentials, stop other credential writers and atomically
  replace the file with a valid token pair and expiry. The next request or health
  probe reloads it; restarting the development process is not required. Invalid
  files are rejected rather than silently replaced with older environment values.
- Without `CLAUDE_AUTH_FILE`, environment-only behavior remains supported. Without
  a refresh token, the access token is static and stops working when it expires.

### Failure isolation

With model health checks enabled (the CLI default), an OAuth refresh failure at
provider initialization leaves that provider unavailable instead of terminating
the multi-provider development process. Other providers continue normally. Health
probes retry and restore each affected service only after it responds successfully.
Refresh attempts have exponential backoff from one second to a maximum of one
minute; actual retries occur on requests/probes, not on a separate refresh timer.
The default health sweep interval is five minutes.

Missing configuration, invalid credential files, and unrelated initialization
errors remain fatal. Disabling model health checks retains fail-fast initialization,
since no background recovery loop would be running. A revoked refresh token still
requires re-authentication; retries cannot make revoked credentials valid.

This plugin remains **for testing and development only**, not subscription-access
resale. No change to authentication reliability changes that restriction.

## License

See the root repository LICENSE file.
