import { randomUUID } from 'crypto';
import { isEphemeralAgentId, GOVERNANCE_AGENT_MODEL_PARAMETERS } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { ServerRequest } from '~/types/http';
import type { GovernanceFetch } from './dlp';
import { GOVERNANCE_ENDPOINT, isGovernancePilotEnabled } from './mode';

const forbiddenFields = new Set([
  'tools',
  'tool_resources',
  'tool_options',
  'actions',
  'agent_ids',
  'edges',
  'subagents',
  'capabilities',
  'skills',
  'skills_enabled',
  'artifacts',
  'mcp',
  'mcpServers',
  'web_search',
  'file_search',
  'execute_code',
  'functions',
  'tool_calls',
  'baseURL',
  'baseUrl',
  'apiKey',
  'headers',
  'script',
  'shell',
]);
const modelFields = new Set([
  'model',
  ...GOVERNANCE_AGENT_MODEL_PARAMETERS,
  'maxOutputTokens',
  'max_context_tokens',
  'max_output_tokens',
  'stop',
  'seed',
  'promptPrefix',
]);

function populated(value: unknown): boolean {
  if (value == null || value === false || value === '') {
    return false;
  }
  if (typeof value === 'object') {
    return Object.values(value).some(populated);
  }
  return true;
}

/** Validate persisted agents too, before resource discovery or tool loading can run. */
export function isGovernanceAgentConfiguration(value: object): boolean {
  return Object.entries(value).every(([key, field]: [string, unknown]) => {
    if (key === 'provider') {
      return field === GOVERNANCE_ENDPOINT;
    }
    if (forbiddenFields.has(key)) {
      return !populated(field);
    }
    if (key === 'model_parameters' && field != null) {
      return (
        typeof field === 'object' &&
        !Array.isArray(field) &&
        Object.entries(field).every(
          ([name, parameter]: [string, unknown]) => modelFields.has(name) || !populated(parameter),
        )
      );
    }
    return true;
  });
}

export function assertGovernanceAgent(agent: Agent): void {
  if (
    isGovernancePilotEnabled() &&
    !isEphemeralAgentId(agent.id) &&
    (agent.provider !== GOVERNANCE_ENDPOINT || !isGovernanceAgentConfiguration(agent))
  ) {
    throw new Error('Only model-only agents using the Governance Gateway are available.');
  }
}

export function governanceAgentMaxSteps(): number {
  const value = process.env.GOVERNANCE_AGENT_MAX_STEPS ?? '10';
  const steps = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(steps) || steps < 1 || steps > 1000) {
    throw new Error('GOVERNANCE_AGENT_MAX_STEPS must be an integer from 1 to 1000');
  }
  return steps;
}

export interface GovernanceAgentRun {
  agentId: string;
  runId: string;
  steps: number;
}

export interface GovernanceAgentRequest extends GovernanceAgentRun {
  stepId: string;
  requestId: string;
}

export function agentRequestHeaders(context: GovernanceAgentRequest): Record<string, string> {
  return {
    'X-LibreChat-Agent-ID': context.agentId,
    'X-LibreChat-Run-ID': context.runId,
    'X-LibreChat-Step-ID': context.stepId,
    'X-LibreChat-Request-ID': context.requestId,
  };
}

/** One server-owned run state is shared by all model fetches, including side calls. */
export function createGovernanceAgentFetch(
  req: ServerRequest,
  fetch: GovernanceFetch,
): GovernanceFetch {
  const body = req.body;
  if (
    !isGovernancePilotEnabled() ||
    body.endpoint !== 'agents' ||
    !body.agent_id ||
    isEphemeralAgentId(body.agent_id)
  ) {
    return fetch;
  }
  const run = (req.governanceAgentRun ??= {
    agentId: body.agent_id,
    runId: randomUUID(),
    steps: 0,
  });
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    if (run.steps >= governanceAgentMaxSteps()) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'The configured maximum number of agent steps was reached.',
            type: 'governance_agent_limit',
            code: 'agent_max_steps',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    run.steps += 1;
    const context: GovernanceAgentRequest = {
      ...run,
      stepId: randomUUID(),
      requestId: randomUUID(),
    };
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    for (const [key, value] of Object.entries(agentRequestHeaders(context))) {
      headers.set(key, value);
    }
    req.governanceAgentRequest = context;
    return fetch(input, { ...init, headers });
  };
}
