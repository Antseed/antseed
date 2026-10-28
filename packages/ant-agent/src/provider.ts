import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import type { AntAgentDefinition } from './loader.js';
import { type AntAgentTool, knowledgeTool } from './tools.js';
import { runAgentLoop, runAgentLoopStream, type AgentLoopOptions, type ResolvedAgent } from './agent-loop.js';

type AgentResolver = (body: Record<string, unknown>) => ResolvedAgent | undefined;

export class AntAgentProvider implements Provider {
  private readonly _inner: Provider;
  private readonly _resolve: AgentResolver;
  private readonly _options: AgentLoopOptions;

  constructor(
    inner: Provider,
    agents: AntAgentDefinition | Record<string, AntAgentDefinition>,
    options?: AgentLoopOptions,
  ) {
    this._inner = inner;
    this._options = options ?? {};
    this._resolve = buildResolver(agents, options?.tools);
  }

  get name() { return this._inner.name; }
  get services() { return this._inner.services; }
  get pricing(): Provider['pricing'] { return this._inner.pricing; }
  get maxConcurrency() { return this._inner.maxConcurrency; }
  get serviceCategories() { return this._inner.serviceCategories; }
  set serviceCategories(v: Record<string, string[]> | undefined) { this._inner.serviceCategories = v; }
  get serviceApiProtocols() { return this._inner.serviceApiProtocols; }
  getCapacity() { return this._inner.getCapacity(); }
  async init() { return this._inner.init?.(); }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    return runAgentLoop(this._inner, req, this._resolve, this._options);
  }

  get handleRequestStream():
    | ((req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => Promise<SerializedHttpResponse>)
    | undefined {
    if (!this._inner.handleRequestStream) return undefined;
    return (req, callbacks) =>
      runAgentLoopStream(this._inner, req, this._resolve, callbacks, this._options);
  }
}

/** Build tools list from knowledge + manifest tools + programmatic tools. Done once at construction. */
function resolveTools(agent: AntAgentDefinition, extra?: AntAgentTool[]): AntAgentTool[] {
  const tools: AntAgentTool[] = [];
  if (agent.knowledge.length > 0) tools.push(knowledgeTool(agent.knowledge));
  if (agent.tools?.length) tools.push(...agent.tools);
  if (extra) tools.push(...extra);

  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`Duplicate tool name: "${t.name}"`);
    seen.add(t.name);
  }

  return tools;
}

function prepareAgent(agent: AntAgentDefinition, extra?: AntAgentTool[]): ResolvedAgent {
  return { definition: agent, tools: resolveTools(agent, extra) };
}

function buildResolver(
  agents: AntAgentDefinition | Record<string, AntAgentDefinition>,
  extraTools?: AntAgentTool[],
): AgentResolver {
  if (isAntAgentDefinition(agents)) {
    const resolved = prepareAgent(agents, extraTools);
    return () => resolved;
  }

  const serviceMap = new Map<string, ResolvedAgent>();
  let defaultAgent: ResolvedAgent | undefined;

  for (const [service, def] of Object.entries(agents)) {
    const resolved = prepareAgent(def, extraTools);
    if (service === '*') {
      defaultAgent = resolved;
    } else {
      serviceMap.set(service, resolved);
    }
  }

  return (body) => {
    const service = (body.service ?? body.model) as string | undefined;
    if (service) {
      const exact = serviceMap.get(service);
      if (exact) return exact;
    }
    return defaultAgent;
  };
}

function isAntAgentDefinition(
  value: AntAgentDefinition | Record<string, AntAgentDefinition>,
): value is AntAgentDefinition {
  return typeof (value as AntAgentDefinition).name === 'string'
    && Array.isArray((value as AntAgentDefinition).guardrails)
    && Array.isArray((value as AntAgentDefinition).knowledge);
}
