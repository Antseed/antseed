import { createBashToolDefinition, type ToolDefinition } from '@mariozechner/pi-coding-agent';

/**
 * The agent's shell, with this run's gateway in its environment for the bundled
 * skills (images, videos). Set per run rather than on `process.env`, where a
 * second chat running at the same time would overwrite the URL and key.
 */
export function createGatewayBashTool(
  cwd: string,
  endpoint: { origin: string; apiKey: string },
  commandPrefix?: string,
): ToolDefinition {
  return createBashToolDefinition(cwd, {
    ...(commandPrefix ? { commandPrefix } : {}),
    spawnHook: (context) => ({
      ...context,
      env: { ...context.env, ANTSEED_PROXY_URL: endpoint.origin, ANTSEED_API_KEY: endpoint.apiKey },
    }),
  }) as unknown as ToolDefinition;
}
