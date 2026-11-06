import { randomUUID } from 'crypto';
import { Providers, initializeModel } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import {
  openAISchema,
  EModelEndpoint,
  parseCompactConvo,
  isEphemeralAgentId,
  removeNullishValues,
} from 'librechat-data-provider';
import type { GovernanceChatCompletionRequest } from '../dlp';
import type { ServerRequest } from '~/types/http';
import type { OpenAIModelOptions } from '~/types';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { loadEphemeralAgent } from '~/agents/load';
import { createRequestDlpFetch, prepareGovernanceAgentRun } from '../dlp';
import { GOVERNANCE_ENDPOINT } from '../mode';

const savedEnv = { ...process.env };
const gateway = 'http://gateway.test/v1';

beforeEach(() => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
  process.env.GOVERNANCE_DLP_ENABLED = 'true';
  process.env.GOVERNANCE_API_BASE_URL = gateway;
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'test';
});

afterEach(() => {
  process.env = { ...savedEnv };
});

async function sendModelRequest({
  model,
  parameters,
  agent = false,
  approval = true,
  streaming = false,
}: {
  model: string;
  parameters: OpenAIModelOptions;
  agent?: boolean;
  approval?: boolean;
  streaming?: boolean;
}) {
  const req = {
    body: {
      endpoint: agent ? EModelEndpoint.agents : GOVERNANCE_ENDPOINT,
      ...(agent ? { agent_id: 'agent_parameters' } : {}),
      text: 'Hello',
    },
    user: { id: 'user-1' },
    config: {},
  } as ServerRequest;
  let modelParameters: OpenAIModelOptions = { ...parameters, model };
  if (!agent) {
    const parsed = parseCompactConvo({
      endpoint: EModelEndpoint.custom,
      endpointType: EModelEndpoint.custom,
      conversation: { model, ...parameters },
    });
    const ephemeral = await loadEphemeralAgent(
      {
        req: { user: req.user, config: req.config, body: {} },
        endpoint: GOVERNANCE_ENDPOINT,
        model_parameters: {
          temperature: null,
          maxContextTokens: null,
          max_context_tokens: null,
          max_output_tokens: null,
          top_p: null,
          frequency_penalty: null,
          presence_penalty: null,
          ...parsed,
          model,
        },
      },
      { getAgent: async () => null, getMCPServerTools: async () => null },
    );
    if (!ephemeral) {
      throw new Error('The classic-chat ephemeral agent was not created');
    }
    expect(isEphemeralAgentId(ephemeral.id)).toBe(true);
    modelParameters = openAISchema.parse(
      removeNullishValues({ ...ephemeral.model_parameters, model: ephemeral.model }),
    );
  }
  const { llmConfig, configOptions } = getOpenAIConfig(
    'test',
    { modelOptions: modelParameters, reverseProxyUrl: gateway, streaming },
    GOVERNANCE_ENDPOINT,
  );
  const sent: Array<{ request: GovernanceChatCompletionRequest; headers: Headers }> = [];
  const sdkRequests: Array<{ max_tokens?: number; max_completion_tokens?: number }> = [];
  const governedFetch = createRequestDlpFetch(
    req,
    async (_input, init) => {
      sent.push({
        request: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      const completion = {
        id: 'chatcmpl-parameters',
        object: streaming ? 'chat.completion.chunk' : 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            ...(streaming
              ? { delta: { role: 'assistant', content: 'ok' } }
              : { message: { role: 'assistant', content: 'ok' } }),
          },
        ],
      };
      return new Response(
        streaming
          ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`
          : JSON.stringify(completion),
        { headers: { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' } },
      );
    },
    approval,
  );
  const chatModel = initializeModel({
    provider: Providers.OPENAI,
    clientOptions: {
      ...llmConfig,
      configuration: {
        ...configOptions,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          sdkRequests.push(JSON.parse(String(init?.body)));
          return governedFetch(input, init);
        },
      },
    },
  });
  const input = [new HumanMessage('Hello')];
  if (streaming) {
    const output = await chatModel.stream(input);
    for await (const chunk of output) {
      expect(chunk.content).toBe('ok');
    }
  } else {
    expect((await chatModel.invoke(input)).content).toBe('ok');
  }
  expect(sent).toHaveLength(1);
  expect(sdkRequests).toHaveLength(1);
  return { ...sent[0], sdkRequest: sdkRequests[0] };
}

it.each([true, false])(
  'preserves classic-chat filtering through the streaming SDK with approval %s',
  async (approval) => {
    const { request, headers } = await sendModelRequest({
      model: 'gemini-3.5-flash',
      parameters: {
        temperature: 0.4,
        top_p: 0.7,
        frequency_penalty: 0,
        presence_penalty: 0,
        max_tokens: 512,
      },
      streaming: true,
      approval,
    });
    expect(request).toEqual({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      temperature: 0.4,
      ...(approval ? { require_user_approval: true } : {}),
    });
    expect(headers.get('X-LibreChat-Agent-ID')).toBeNull();
    expect(headers.get('X-LibreChat-Run-ID')).toBeNull();
  },
);

it.each([true, false])(
  'retains saved-agent parameters through the streaming SDK with approval %s',
  async (approval) => {
    const parameters = {
      temperature: 0.4,
      frequency_penalty: 0.2,
      presence_penalty: -0.1,
      max_tokens: 512,
    };
    const { request, headers } = await sendModelRequest({
      model: 'logical-model',
      parameters,
      agent: true,
      streaming: true,
      approval,
    });
    expect(request).toEqual({
      model: 'logical-model',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      ...parameters,
      ...(approval ? { require_user_approval: true } : {}),
    });
    expect(headers.get('X-LibreChat-Agent-ID')).toBe('agent_parameters');
    expect(headers.get('X-LibreChat-Run-ID')).toMatch(/^[\da-f-]{36}$/);
  },
);

it('keeps the normalized agent token limit and correlation when a DLP review is approved', async () => {
  const reviewId = randomUUID();
  const messages = [{ role: 'user', content: 'test@example.com' }];
  const sent: Array<{ request: GovernanceChatCompletionRequest; headers: Headers }> = [];
  const firstRequest = {
    body: {
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_parameters',
      text: 'test@example.com',
    },
    user: { id: 'user-1' },
  } as ServerRequest;
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request: GovernanceChatCompletionRequest = JSON.parse(String(init?.body));
    sent.push({ request, headers: new Headers(init?.headers) });
    return new Response(
      JSON.stringify(
        request.dlp_token
          ? {}
          : {
              choices: [],
              dlp: {
                review_id: reviewId,
                action: 'WARN',
                policy_version: 1,
                findings: [
                  {
                    location: '/messages/0/content',
                    start: 0,
                    end: 16,
                    category: 'EMAIL_ADDRESS',
                    action: 'WARN',
                  },
                ],
                messages,
                dlp_token: 'approval-token',
              },
            },
      ),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const init = {
    method: 'POST',
    body: JSON.stringify({
      model: 'internal-gpt-5-alias',
      messages,
      max_completion_tokens: 256,
    }),
  };
  const first = await createRequestDlpFetch(firstRequest, fetch)(
    `${gateway}/chat/completions`,
    init,
  );
  expect(first.status).toBe(400);
  expect(firstRequest.governanceDlpReview?.reviewId).toBe(reviewId);
  const approvedRequest = {
    body: { ...firstRequest.body, dlpReviewId: reviewId },
    user: firstRequest.user,
  } as ServerRequest;
  await prepareGovernanceAgentRun(approvedRequest);
  const approved = await createRequestDlpFetch(approvedRequest, fetch)(
    `${gateway}/chat/completions`,
    init,
  );
  expect(approved.ok).toBe(true);
  expect(sent).toHaveLength(2);
  expect(sent[0].request).toEqual({
    model: 'internal-gpt-5-alias',
    messages,
    max_tokens: 256,
    require_user_approval: true,
  });
  expect(sent[1].request).toEqual({ ...sent[0].request, dlp_token: 'approval-token' });
  for (const header of [
    'X-LibreChat-Agent-ID',
    'X-LibreChat-Run-ID',
    'X-LibreChat-Step-ID',
    'X-LibreChat-Request-ID',
  ]) {
    expect(sent[1].headers.get(header)).toBe(sent[0].headers.get(header));
  }
});

it.each([
  ['internal-gpt-5-alias', true, true],
  ['internal-gpt-5-alias', false, false],
  ['o1', true, false],
  ['o1', false, true],
] as const)(
  'normalizes the SDK token limit for agent model %s with approval %s and streaming %s',
  async (model, approval, streaming) => {
    const { request, sdkRequest, headers } = await sendModelRequest({
      model,
      parameters: { max_tokens: 256 },
      agent: true,
      approval,
      streaming,
    });
    expect(sdkRequest.max_completion_tokens).toBe(256);
    expect(request.max_tokens).toBe(256);
    expect(request).not.toHaveProperty('max_completion_tokens');
    expect(headers.get('X-LibreChat-Agent-ID')).toBe('agent_parameters');
  },
);
