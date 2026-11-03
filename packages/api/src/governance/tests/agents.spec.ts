import { randomUUID } from 'crypto';
import { z } from 'zod';
import { FakeChatModel } from '@librechat/agents';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { Agent } from 'librechat-data-provider';
import type { ServerRequest } from '~/types/http';
import { createRun } from '~/agents/run';
import { createRequestDlpFetch, prepareGovernanceAgentRun } from '../dlp';
import { getReviewStore } from '../review';
import { GOVERNANCE_ENDPOINT } from '../mode';
import { assertGovernanceAgent, governanceAgentMaxSteps } from '../agents';

const savedEnv = { ...process.env };
const url = 'http://gateway.test/api/v1/dlp/chat/completions';

beforeEach(() => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
  process.env.GOVERNANCE_DLP_ENABLED = 'true';
  process.env.GOVERNANCE_API_BASE_URL = 'http://gateway.test/api/v1/dlp';
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'service-credential';
  process.env.GOVERNANCE_AGENT_MAX_STEPS = '10';
  process.env.OPENAI_API_KEY = 'test';
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const modelOnlyAgent: Agent = {
  id: 'agent_test',
  name: 'Test agent',
  description: null,
  created_at: 0,
  avatar: null,
  provider: GOVERNANCE_ENDPOINT,
  model: 'logical-model',
  model_parameters: {
    useResponsesApi: false,
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
  tools: [],
  tool_options: {},
  tool_resources: {},
  edges: [],
  artifacts: '',
  skills_enabled: false,
};

it('accepts the model-only builder defaults and bounds the operational limit', () => {
  expect(() => assertGovernanceAgent(modelOnlyAgent)).not.toThrow();
  expect(governanceAgentMaxSteps()).toBe(10);
  process.env.GOVERNANCE_AGENT_MAX_STEPS = '0';
  expect(governanceAgentMaxSteps).toThrow();
});

it.each([
  { provider: 'openAI' },
  { tools: ['governance_test_echo'] },
  { tools: ['execute_code'] },
  { tools: ['unknown'] },
  { capabilities: ['unknown'] },
  { edges: [{ to: 'agent_other' }] },
  { tool_resources: { context: { file_ids: ['file'] } } },
  { subagents: { enabled: true } },
  { skills_enabled: true },
  { model_parameters: { useResponsesApi: true } },
  { model_parameters: { tools: [{ type: 'web_search_preview' }] } },
  { model_parameters: { configuration: { baseURL: 'https://provider.test' } } },
])('rejects executable or bypassing saved agent configuration %j', (extra) => {
  expect(() => assertGovernanceAgent({ ...modelOnlyAgent, ...extra } as Agent)).toThrow();
});

/** The deterministic tool exists only in this test module; the application never registers it. */
async function agentLoop(maxSteps = '10', cancelAfterTool = false) {
  process.env.GOVERNANCE_AGENT_MAX_STEPS = maxSteps;
  const controller = new AbortController();
  const request = {
    body: { endpoint: 'agents', agent_id: 'agent_test', text: 'echo please' },
    user: { id: 'user-1' },
  } as ServerRequest;
  const calls: Array<{ headers: Headers; messages: Array<{ role: string; content: string }> }> = [];
  const fetch = createRequestDlpFetch(request, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    calls.push({ headers: new Headers(init?.headers), messages: body.messages });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const echo = jest.fn(async ({ text }: { text: string }) => {
    if (cancelAfterTool) {
      controller.abort();
    }
    return text;
  });
  const tool = new DynamicStructuredTool({
    name: 'governance_test_echo',
    description: 'Deterministic test echo',
    schema: z.object({ text: z.string() }),
    func: echo,
  });
  const messages = [new HumanMessage('echo please')];
  const run = await createRun({
    runId: randomUUID(),
    signal: controller.signal,
    messages,
    agents: [
      {
        ...modelOnlyAgent,
        id: 'agent_test',
        provider: 'openAI',
        model: 'logical-model',
        tools: [tool],
        model_parameters: { ...modelOnlyAgent.model_parameters, model: 'logical-model' },
        maxContextTokens: 32000,
      },
    ] as Parameters<typeof createRun>[0]['agents'],
    summarizationConfig: { enabled: false },
  });
  const model = new FakeChatModel({
    responses: ['Checking', 'Done'],
    toolCalls: [{ name: tool.name, args: { text: 'deterministic result' }, id: 'call_test' }],
  });
  const stream = model._streamResponseChunks.bind(model);
  jest
    .spyOn(model, '_streamResponseChunks')
    .mockImplementation(async function* (input, options, manager) {
      // Only this test adapter maps the native tool protocol to model-only text transport.
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model: 'logical-model',
          messages: input.map((message) => ({
            role:
              ({ human: 'user', ai: 'assistant' } as Record<string, string>)[message.getType()] ??
              'system',
            content: typeof message.content === 'string' ? message.content : '',
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      yield* stream(input, options, manager);
    });
  run.Graph!.overrideModel = model;
  let error: Error | undefined;
  try {
    await run.processStream(
      { messages },
      {
        configurable: { thread_id: 'governance-test' },
        recursionLimit: 20,
        version: 'v2',
        signal: controller.signal,
      },
    );
  } catch (caught) {
    error = caught as Error;
  }
  return { calls, echo, error, run, request };
}

it('completes the native multi-step agent/tool loop with correlated governed model calls', async () => {
  const { calls, echo, error, run } = await agentLoop();
  expect(error).toBeUndefined();
  expect(echo).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(2);
  const messages = run.getRunMessages() ?? [];
  expect(messages[messages.length - 1]?.content).toBe('Done');
  for (const name of ['X-LibreChat-Agent-ID', 'X-LibreChat-Run-ID']) {
    expect(calls[0].headers.get(name)).toBe(calls[1].headers.get(name));
  }
  for (const name of ['X-LibreChat-Step-ID', 'X-LibreChat-Request-ID']) {
    expect(calls[0].headers.get(name)).toMatch(/^[\da-f-]{36}$/);
    expect(calls[0].headers.get(name)).not.toBe(calls[1].headers.get(name));
  }
  expect(calls[1].messages).toContainEqual({ role: 'assistant', content: 'Checking' });
});

it('stops the native loop at the configured model-step limit', async () => {
  const { calls, echo, error } = await agentLoop('1');
  expect(echo).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(1);
  expect(error?.message).toContain('agent_max_steps');
});

it('cancels the native loop before the next model request', async () => {
  const { calls, echo, error } = await agentLoop('10', true);
  expect(echo).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(1);
  expect(error).toBeDefined();
});

it('restores approval correlation before graph creation and consumes it before the next step', async () => {
  const context = {
    agentId: 'agent_test',
    runId: randomUUID(),
    stepId: randomUUID(),
    requestId: randomUUID(),
    steps: 1,
  };
  const store = getReviewStore();
  await store.set(
    context.requestId,
    {
      userId: 'user-1',
      model: 'logical-model',
      text: 'approved text',
      messages: [{ role: 'user', content: 'approved text' }],
      dlpToken: 'test-token',
      agentRequest: context,
    },
    5000,
  );
  const request = {
    body: {
      endpoint: 'agents',
      agent_id: 'agent_test',
      text: 'approved text',
      dlpReviewId: context.requestId,
    },
    user: { id: 'user-1' },
  } as ServerRequest;
  await prepareGovernanceAgentRun(request);
  expect(request.governanceAgentRun?.runId).toBe(context.runId);
  const calls: Array<{ headers: Headers; token?: string }> = [];
  const fetch = createRequestDlpFetch(request, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { dlp_token?: string };
    calls.push({ headers: new Headers(init?.headers), token: body.dlp_token });
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
  const init = {
    method: 'POST',
    body: JSON.stringify({
      model: 'logical-model',
      messages: [{ role: 'user', content: 'approved text' }],
    }),
  };
  expect((await fetch(url, init)).ok).toBe(true);
  expect((await fetch(url, init)).ok).toBe(true);
  expect(calls[0].token).toBe('test-token');
  expect(calls[1].token).toBeUndefined();
  expect(calls[0].headers.get('X-LibreChat-Request-ID')).toBe(context.requestId);
  expect(calls[1].headers.get('X-LibreChat-Request-ID')).not.toBe(context.requestId);
  expect(calls[1].headers.get('X-LibreChat-Run-ID')).toBe(context.runId);
});
