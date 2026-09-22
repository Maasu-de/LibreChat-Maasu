import express from 'express';
import { configSchema, Constants, ContentTypes } from 'librechat-data-provider';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TCustomConfig } from 'librechat-data-provider';
import {
  GOVERNANCE_ENDPOINT,
  enforceGovernancePilot,
  assertGovernancePilotHistory,
  filterGovernanceEndpoints,
  applyGovernancePilotConfig,
} from '../pilot';

const environmentKeys = [
  'GOVERNANCE_PILOT_ENABLED',
  'GOVERNANCE_DLP_ENABLED',
  'GOVERNANCE_API_BASE_URL',
  'LIBRECHAT_SERVICE_CREDENTIAL',
  'OPENAI_MODERATION',
] as const;
const previousEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);
const chatPath = `/api/agents/chat/${encodeURIComponent(GOVERNANCE_ENDPOINT)}`;
const submission = {
  endpoint: GOVERNANCE_ENDPOINT,
  endpointType: 'custom',
  model: 'pilot',
  text: 'Hi',
};
let server: Server;
let baseURL: string;
let reachedFeature: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', enforceGovernancePilot);
  app.use((_req, res) => {
    reachedFeature++;
    res.json({ reachedFeature: true });
  });
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  reachedFeature = 0;
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
  process.env.GOVERNANCE_DLP_ENABLED = 'true';
  process.env.GOVERNANCE_API_BASE_URL = 'http://governance.test/v1';
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'test-credential';
  process.env.OPENAI_MODERATION = 'false';
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const key of environmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

async function send(path: string, body: object = submission, method = 'POST'): Promise<Response> {
  return fetch(`${baseURL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) }),
  });
}

describe('governed pilot HTTP boundary', () => {
  it.each([
    submission,
    { ...submission, agent_id: Constants.EPHEMERAL_AGENT_ID },
    { ...submission, files: [], tools: [], ephemeralAgent: { mcp: [], web_search: false } },
  ])('preserves ordinary and follow-up text chat: %j', async (body) => {
    expect((await send(chatPath, body)).status).toBe(200);
    expect(reachedFeature).toBe(1);
  });

  it.each([
    { endpoint: 'openAI' },
    { endpointType: 'openAI' },
    { endpointType: 'agents' },
    { files: [{ file_id: 'existing-file' }] },
    { files: 'malformed' },
    { tools: ['image_gen'] },
    { agent_id: 'agent_persisted' },
    { assistant_id: 'asst_saved' },
    { addedConvo: { endpoint: 'openAI' } },
    { isContinued: true },
    { isRegenerate: true },
    { editedContent: { type: 'text', text: 'changed' } },
    { useResponsesApi: true },
    { ephemeralAgent: { web_search: true } },
    { ephemeralAgent: { execute_code: true } },
    { ephemeralAgent: { file_search: true } },
    { ephemeralAgent: { mcp: ['server'] } },
    { ephemeralAgent: { mcp: 'server' } },
    { ephemeralAgent: { artifacts: 'default' } },
    { text: '' },
  ])('rejects unsupported or stale submissions before feature code: %j', async (extra) => {
    expect((await send(chatPath, { ...submission, ...extra })).status).toBe(403);
    expect(reachedFeature).toBe(0);
  });

  it.each([
    '/api/agents/chat/openAI',
    '/api/agents/chat/agents',
    '/api/agents/chat',
    '/api/agents',
    '/api/agents/actions',
    '/api/agents/tools',
    '/api/agents/v1/chat/completions',
    '/api/agents/v1/responses',
    '/api/assistants/v2/chat',
    '/api/assistants/v1/chat',
    '/api/files/images',
    '/api/files/speech/stt',
    '/api/files/speech/tts',
    '/api/mcp',
    '/api/actions',
    '/api/keys',
    '/api/api-keys',
    '/api/memories',
    '/api/convos/import',
    '/api/FILES/images/',
    '/api/%61gents/v1/responses',
  ])('blocks direct API requests to %s', async (path) => {
    expect((await send(path)).status).toBe(403);
    expect(reachedFeature).toBe(0);
  });

  it('blocks manual background title generation', async () => {
    expect((await send('/api/convos/gen_title/conversation', {}, 'GET')).status).toBe(403);
    expect(reachedFeature).toBe(0);
  });

  it('blocks deletion of an existing file', async () => {
    expect((await send('/api/files/old-file', {}, 'DELETE')).status).toBe(403);
    expect(reachedFeature).toBe(0);
  });

  it.each([
    '/api/agents/chat/active',
    '/api/agents/chat/status/conversation',
    '/api/agents/chat/stream/conversation',
    '/api/files',
    '/api/files/old-file',
    '/api/files/images/old-image',
    '/api/files/config',
    '/api/files/speech/config/get',
    '/api/convos',
    '/api/messages',
    '/api/models',
    '/api/config',
    '/api/endpoints',
    '/api/search',
    '/api/admin',
  ])('preserves chat infrastructure and local data reads: %s', async (path) => {
    expect((await send(path, {}, 'GET')).status).toBe(200);
  });

  it('preserves abort', async () => {
    expect((await send('/api/agents/chat/abort', { conversationId: 'chat' })).status).toBe(200);
  });

  it('leaves non-pilot deployments unchanged', async () => {
    process.env.GOVERNANCE_PILOT_ENABLED = 'false';
    expect((await send('/api/agents/v1/responses')).status).toBe(200);
  });
});

describe('governed pilot configuration', () => {
  const config: TCustomConfig = {
    version: '1.3.6',
    endpoints: {
      custom: [
        {
          name: GOVERNANCE_ENDPOINT,
          apiKey: 'user_provided',
          baseURL: 'https://other.test',
          models: { default: ['pilot'] },
          titleConvo: true,
          summarize: true,
        },
        { name: 'Other', baseURL: 'https://other.test' },
      ],
    },
    interface: { agents: true, webSearch: true, modelSelect: false },
    mcpServers: { unsafe: { command: 'unsafe' } },
    includedTools: ['image_gen'],
  };

  it('pins provider credentials, removes auxiliary providers and tools, and keeps model selection', () => {
    const result = applyGovernancePilotConfig(config);
    expect(configSchema.safeParse(result).success).toBe(true);
    expect(result.endpoints?.custom).toEqual([
      {
        name: GOVERNANCE_ENDPOINT,
        apiKey: '${LIBRECHAT_SERVICE_CREDENTIAL}',
        baseURL: '${GOVERNANCE_API_BASE_URL}',
        models: { default: ['pilot'], fetch: true },
        headers: { 'X-LibreChat-User-ID': '{{LIBRECHAT_USER_ID}}' },
        titleConvo: false,
        summarize: false,
      },
    ]);
    expect(result.interface).toMatchObject({
      modelSelect: true,
      parameters: false,
      webSearch: false,
      agents: { use: false, create: false },
    });
    expect(result.fileConfig?.endpoints?.[GOVERNANCE_ENDPOINT]?.disabled).toBe(true);
    expect(result.mcpServers).toBeUndefined();
    expect(result.includedTools).toEqual([]);
    expect(result.modelSpecs).toBeUndefined();
    expect(result.speech?.speechTab?.speechToText).toBe(false);
    expect(config.endpoints?.custom).toHaveLength(2);
  });

  it.each(environmentKeys.slice(1, 4))('fails closed without %s', (key) => {
    delete process.env[key];
    expect(() => applyGovernancePilotConfig(config)).toThrow('Governed pilot requires');
  });

  it('rejects missing gateway configuration', () => {
    expect(() => applyGovernancePilotConfig({})).toThrow('custom endpoint');
  });

  it('rejects external moderation', () => {
    process.env.OPENAI_MODERATION = 'true';
    expect(() => applyGovernancePilotConfig(config)).toThrow('external OpenAI moderation');
  });

  it('filters cached endpoint discovery even if provider credentials exist', () => {
    expect(
      filterGovernanceEndpoints({
        openAI: { userProvide: true, order: 1 },
        [GOVERNANCE_ENDPOINT]: { userProvide: false, order: 0 },
      }),
    ).toEqual({ [GOVERNANCE_ENDPOINT]: { userProvide: false, order: 0 } });
    expect(filterGovernanceEndpoints({ openAI: { userProvide: true, order: 1 } })).toEqual({});
  });

  it('does not modify ordinary deployments', () => {
    process.env.GOVERNANCE_PILOT_ENABLED = 'false';
    expect(applyGovernancePilotConfig(config)).toBe(config);
  });
});

describe('governed conversation history', () => {
  it('allows plain text and textual errors in saved conversations', () => {
    expect(() =>
      assertGovernancePilotHistory([
        { files: [], content: [{ type: ContentTypes.TEXT, text: 'Hello' }] },
        { content: [{ type: ContentTypes.ERROR, text: 'A previous failure' }] },
      ]),
    ).not.toThrow();
  });

  it('rejects saved attachments before retrieval can process them', () => {
    expect(() => assertGovernancePilotHistory([{ files: [{ file_id: 'old-file' }] }])).toThrow(
      'unsupported content',
    );
  });

  it('rejects historical tool results', () => {
    expect(() =>
      assertGovernancePilotHistory([
        {
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                id: 'call-1',
                type: 'function',
                function: { name: 'search', arguments: '{}', output: 'result' },
              },
            },
          ],
        },
      ]),
    ).toThrow('unsupported content');
  });

  it('preserves non-pilot history handling', () => {
    process.env.GOVERNANCE_PILOT_ENABLED = 'false';
    expect(() =>
      assertGovernancePilotHistory([{ files: [{ file_id: 'old-file' }] }]),
    ).not.toThrow();
  });
});
