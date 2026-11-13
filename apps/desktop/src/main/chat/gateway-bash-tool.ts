import { createBashToolDefinition, type ToolDefinition } from '@mariozechner/pi-coding-agent';

/**
 * The agent's shell, with a way to this run's gateway for the bundled skills
 * (images, videos). Set per run rather than on `process.env`, where a second
 * chat running at the same time would overwrite it. `gateway` is the relay's
 * address and token, never the real key: see gateway-shell-relay.ts.
 */
export function createGatewayBashTool(
  cwd: string,
  gateway: { url: string; token: string },
  commandPrefix?: string,
): ToolDefinition {
  return createBashToolDefinition(cwd, {
    ...(commandPrefix ? { commandPrefix } : {}),
    spawnHook: (context) => ({
      ...context,
      env: { ...context.env, ANTSEED_PROXY_URL: gateway.url, ANTSEED_API_KEY: gateway.token },
    }),
  }) as unknown as ToolDefinition;
}
