import express from 'express';
import request from 'supertest';
import { AppService } from '@librechat/data-schemas';
import { AgentCapabilities } from 'librechat-data-provider';
import { Constants, FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { restrictGovernanceConfig, restrictGovernanceAppConfig } from '../config';
import { enforceGovernancePilot, createGovernanceHistoryGuard } from '../pilot';
import { createEndpointsConfigService } from '~/endpoints/config/endpoints';
import { createGovernanceDlpFetch } from '../dlp';
import { GOVERNANCE_ENDPOINT } from '../mode';

const savedEnv = { ...process.env };
const chatPath = `/api/agents/chat/${encodeURIComponent(GOVERNANCE_ENDPOINT)}`;
const plain = {
  endpoint: GOVERNANCE_ENDPOINT,
  endpointType: 'custom',
  text: 'Hello',
  model: 'logical-model',
};

beforeEach(() => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
  process.env.GOVERNANCE_DLP_ENABLED = 'true';
  process.env.GOVERNANCE_API_BASE_URL = 'http://gateway.test/v1';
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'service-credential';
  process.env.OPENAI_MODERATION = 'false';
});
afterEach(() => {
  process.env = { ...savedEnv };
});

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api', enforceGovernancePilot);
  server.use((_req, res) => {
    res.sendStatus(204);
  });
  return server;
}

describe('pilot HTTP boundary', () => {
  it.each([
    {},
    { agent_id: Constants.EPHEMERAL_AGENT_ID },
    { files: [], tools: [], ephemeralAgent: { web_search: false, mcp: [] } },
    { conversationId: 'existing', parentMessageId: 'reply', isRegenerate: false },
  ])('allows ordinary text chat and follow-ups: %j', async (extra) => {
    await expect(
      request(app())
        .post(chatPath)
        .send({ ...plain, ...extra }),
    ).resolves.toMatchObject({ status: 204 });
  });

  it.each([
    '/api/agents/chat/openAI',
    '/api/agents/chat',
    '/api/assistants',
    '/api/agents/v1/chat/completions',
    '/api/agents/v1/responses',
    '/api/agents/v1',
    '/api/keys',
    '/api/api-keys',
    '/api/files',
    '/api/files/images',
    '/api/files/speech/stt',
    '/api/files/speech/tts',
    '/api/actions',
    '/api/mcp',
    '/api/memories',
    '/api/skills',
    '/api/presets',
    '/api/convos/import',
    '/api/messages/artifact/message',
    '/api/messages/conversation',
    '/api/admin/config',
    '/api/admin/skills',
    '/api/FILES/images/',
    '/api/%61gents/v1',
  ])('blocks unsupported API %s before its handler', async (path) => {
    const response = await request(app()).post(path).send(plain).expect(403);
    expect(response.body.type).toBe('governance_feature_unsupported');
  });

  it.each([
    { endpoint: 'openAI' },
    { endpointType: 'agents' },
    { agent_id: 'agent_persistent' },
    { files: [{ file_id: 'uploaded' }] },
    { tools: ['web-search'] },
    { ephemeralAgent: { mcp: ['server'] } },
    { ephemeralAgent: { artifacts: 'html' } },
    { ephemeralAgent: { skills: true } },
    { ephemeralAgent: { execute_code: true } },
    { ephemeralAgent: { web_search: true } },
    { ephemeralAgent: { file_search: true } },
    { manualSkills: ['export-data'] },
    { assistant_id: 'asst_external' },
    { isRegenerate: true },
    { isContinued: true },
    { addedConvo: { model: 'other' } },
    { editedContent: { text: 'edited' } },
    { useResponsesApi: true },
    { model_parameters: { useResponsesApi: true } },
    { endpointOption: { modelOptions: { useResponsesApi: true } } },
    { endpointOption: { endpoint: 'external' } },
    { baseURL: 'https://external.test' },
    { content: [{ type: 'image_url', image_url: { url: 'https://external.test' } }] },
  ])('blocks incompatible saved or crafted submission: %j', async (extra) => {
    await expect(
      request(app())
        .post(chatPath)
        .send({ ...plain, ...extra }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it.each([
    '/api/convos',
    '/api/search?q=text',
    '/api/messages/conversation',
    '/api/files',
    '/api/files/config',
    '/api/files/speech/config',
    '/api/admin/config',
    '/api/agents/chat/active',
    '/api/agents/chat/stream/job',
    '/api/agents/chat/status/convo',
  ])('preserves read-only history, config, and stream controls: %s', async (path) => {
    await expect(request(app()).get(path)).resolves.toMatchObject({ status: 204 });
  });

  it('allows stream abort and manual renaming', async () => {
    await expect(
      request(app()).post('/api/agents/chat/abort').send({ streamId: 'job' }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      request(app())
        .post('/api/convos/update')
        .send({ arg: { title: 'My title' } }),
    ).resolves.toMatchObject({ status: 204 });
  });
  it('blocks GET title and integration endpoints', async () => {
    for (const path of [
      '/api/convos/gen_title/id',
      '/api/mcp',
      '/api/agents/v1',
      '/api/files/speech/tts',
    ]) {
      await expect(request(app()).get(path)).resolves.toMatchObject({ status: 403 });
    }
  });
  it('retains upstream behavior when pilot mode is disabled', async () => {
    process.env.GOVERNANCE_PILOT_ENABLED = 'false';
    await expect(request(app()).post('/api/files/images').send({})).resolves.toMatchObject({
      status: 204,
    });
    await expect(request(app()).post('/api/agents/v1/responses').send({})).resolves.toMatchObject({
      status: 204,
    });
  });
});

describe('saved history boundary', () => {
  it.each([{ content: [{ type: 'text', text: 'Saved text' }] }, { text: 'Saved text' }])(
    'preserves text-only history: %j',
    async (messages) => {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        Object.assign(req, { user: { id: 'user-1' } });
        next();
      });
      server.use(createGovernanceHistoryGuard(async () => [messages]));
      server.use((_req, res) => {
        res.sendStatus(204);
      });
      await expect(
        request(server).post('/').send({ conversationId: 'existing' }),
      ).resolves.toMatchObject({ status: 204 });
    },
  );

  it.each([
    { files: [{ file_id: 'f' }] },
    { attachments: [{ file_id: 'f' }] },
    { content: [{ type: 'tool_call', tool_call: { name: 'web' } }] },
    { content: [{ type: 'image_url' }] },
    { content: [null] },
  ])('rejects historical files/tool content before initialization: %j', async (message) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'user-1' } });
      next();
    });
    server.use(
      createGovernanceHistoryGuard(async (filter) => {
        expect(filter).toEqual({ conversationId: 'existing', user: 'user-1' });
        return [message];
      }),
    );
    server.use((_req, res) => {
      res.sendStatus(204);
    });
    await expect(
      request(server).post('/').send({ conversationId: 'existing' }),
    ).resolves.toMatchObject({ status: 403 });
  });
});

describe('pilot configuration', () => {
  it('pins provider credentials and removes integrations before AppService defaults', async () => {
    const config = restrictGovernanceConfig({
      endpoints: {
        custom: [
          {
            name: 'external',
            apiKey: 'user_provided',
            baseURL: 'https://external.test',
            models: { default: ['model'] },
          },
        ],
      },
      interface: { agents: true, webSearch: true, skills: true },
      mcpServers: { external: { url: 'https://external.test' } },
      speech: { speechTab: { speechToText: true } },
    });
    const result = restrictGovernanceAppConfig(await AppService({ config }));
    expect(result.endpoints?.custom).toHaveLength(1);
    expect(result.endpoints?.custom?.[0]).toMatchObject({
      name: GOVERNANCE_ENDPOINT,
      apiKey: '${LIBRECHAT_SERVICE_CREDENTIAL}',
      baseURL: '${GOVERNANCE_API_BASE_URL}',
      headers: { 'X-LibreChat-User-ID': '{{LIBRECHAT_USER_ID}}' },
      models: { fetch: true },
      titleConvo: false,
    });
    expect(result.endpoints?.agents?.capabilities).toEqual([]);
    expect(result.interfaceConfig).toMatchObject({
      skills: false,
      agents: false,
      webSearch: false,
    });
    expect(result.mcpConfig).toBeNull();
    expect(result.availableTools).toEqual({});
    expect(result.memory).toBeUndefined();
    expect(result.summarization?.enabled).toBe(false);
  });

  it('overrides derived admin configuration and preserves unrelated settings', () => {
    const base: AppConfig = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      interfaceConfig: { agents: true, modelSelect: false },
      endpoints: { openAI: { titleConvo: true } },
      registration: { socialLogins: ['openid'] },
    };
    const result = restrictGovernanceAppConfig(base);
    expect(result.endpoints?.openAI).toBeUndefined();
    expect(result.interfaceConfig?.modelSelect).toBe(true);
    expect(result.registration).toEqual(base.registration);
    expect(base.endpoints?.openAI).toBeDefined();
  });

  it.each(['GOVERNANCE_DLP_ENABLED', 'LIBRECHAT_SERVICE_CREDENTIAL', 'GOVERNANCE_API_BASE_URL'])(
    'fails closed when %s is absent',
    (key) => {
      delete process.env[key];
      expect(() => restrictGovernanceConfig({})).toThrow();
    },
  );
  it('advertises only the gateway and does not enable default custom-endpoint tools', async () => {
    const config = restrictGovernanceAppConfig(
      await AppService({ config: restrictGovernanceConfig({}) }),
    );
    const services = createEndpointsConfigService({
      getAppConfig: async () => config,
      loadDefaultEndpointsConfig: async () => {
        throw new Error('Must not load direct providers');
      },
    });
    const req = {
      config,
      body: { endpoint: GOVERNANCE_ENDPOINT, endpointType: 'custom' },
    } as ServerRequest;
    const endpoints = await services.getEndpointsConfig(req);
    expect(Object.keys(endpoints ?? {})).toEqual([GOVERNANCE_ENDPOINT]);
    expect(endpoints?.[GOVERNANCE_ENDPOINT]).toMatchObject({ type: 'custom', userProvide: false });
    expect(await services.checkCapability(req, AgentCapabilities.tools)).toBe(false);
    expect(await services.checkCapability(req, AgentCapabilities.skills)).toBe(false);
  });

  it('rejects external moderation at startup', () => {
    process.env.OPENAI_MODERATION = 'true';
    expect(() => restrictGovernanceConfig({})).toThrow(/moderation/);
  });
  it('does not change non-pilot configuration', () => {
    delete process.env.GOVERNANCE_PILOT_ENABLED;
    const config = { interface: { agents: true } };
    expect(restrictGovernanceConfig(config)).toBe(config);
  });
});

describe('pilot outbound boundary', () => {
  const valid = {
    model: 'logical-model',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  };
  it.each([
    ['https://external.test/v1/chat/completions', valid],
    ['http://gateway.test/v1/responses', valid],
    ['http://gateway.test/v1/models', valid],
    ['http://gateway.test/v1/chat/completions', { ...valid, stream: false }],
    ['http://gateway.test/v1/chat/completions', { ...valid, tools: [{ type: 'function' }] }],
    [
      'http://gateway.test/v1/chat/completions',
      { ...valid, messages: [{ role: 'tool', content: 'result' }] },
    ],
  ])('never forwards unsupported destination or request %s %j', async (url, body) => {
    const fetch = jest.fn();
    const check = jest.fn();
    const governed = createGovernanceDlpFetch({ userId: 'user-1', fetch, check });
    await expect(governed(url, { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
  it('preserves the streaming response and forwards a signed token for the exact text body', async () => {
    const upstream = new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-DLP-Token')).toBe('signed');
      expect(new Headers(init?.headers).get('X-LibreChat-User-ID')).toBe('user-1');
      expect(JSON.parse(String(init?.body))).toEqual(valid);
      return upstream;
    });
    const governed = createGovernanceDlpFetch({
      userId: 'user-1',
      fetch,
      check: async ({ request: body }) => {
        expect(body).toEqual(valid);
        return { decision: 'ALLOW', findings: [], dlpToken: 'signed' };
      },
    });
    expect(
      await governed('http://gateway.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(valid),
      }),
    ).toBe(upstream);
  });
});
