import express from 'express';
import request from 'supertest';
import { AppService } from '@librechat/data-schemas';
import {
  AgentCapabilities,
  createPayload,
  EModelEndpoint,
  GOVERNANCE_AGENT_MODEL_PARAMETERS,
} from 'librechat-data-provider';
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
  process.env.OPENID_REUSE_TOKENS = 'true';
  process.env.OPENID_ADMIN_ROLE = 'governance-admin';
  process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'realm_access.roles';
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
  it.each(GOVERNANCE_AGENT_MODEL_PARAMETERS)(
    'allows saving the visible Agent Builder parameter %s',
    async (key) => {
      const values = {
        maxContextTokens: 4096,
        max_tokens: 512,
        temperature: 0.4,
        top_p: 0.7,
        frequency_penalty: 0.1,
        presence_penalty: -0.1,
      };
      const response = await request(app())
        .patch('/api/agents/agent_test')
        .send({ model_parameters: { [key]: values[key] } })
        .expect(204);
      expect(response.status).toBe(204);
    },
  );

  it.each([null, 'conversation-1'])(
    'allows the actual saved-agent UI submission for conversation %s',
    async (conversationId) => {
      const { server, payload } = createPayload({
        conversation: { conversationId, endpoint: EModelEndpoint.agents, agent_id: 'agent_test' },
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          endpointType: EModelEndpoint.agents,
          agent_id: 'agent_test',
        },
        userMessage: {
          messageId: 'message-1',
          parentMessageId: conversationId ? 'reply' : String(Constants.NO_PARENT),
          conversationId,
          text: 'Hello',
          isCreatedByUser: true,
        },
        isTemporary: false,
        messages: [],
      });

      expect(server).toBe('/api/agents/chat/agents');
      await request(app()).post(server).send(payload).expect(204);
    },
  );

  it.each([
    { agent_id: null },
    { provider: 'openAI' },
    { tools: ['execute_code'] },
    { capabilities: ['unknown'] },
    { addedConvo: { endpoint: GOVERNANCE_ENDPOINT, endpointType: 'custom', model: 'other-model' } },
    { addedConvo: {} },
    { addedConvo: false },
    { addedConvo: '' },
    { addedConvo: [] },
  ])('rejects unsupported saved-agent UI submissions %j', async (extra) => {
    const response = await request(app())
      .post('/api/agents/chat/agents')
      .send({ endpoint: 'agents', agent_id: 'agent_test', text: 'Hello', ...extra })
      .expect(403);
    expect(response.body.type).toBe('governance_feature_unsupported');
  });

  it('allows model-only Agent Builder create, edit, list, selection, and chat', async () => {
    const agent = {
      provider: GOVERNANCE_ENDPOINT,
      model: 'logical-model',
      name: 'My agent',
      instructions: 'Answer briefly',
      tools: [],
      tool_options: {},
      edges: [],
      artifacts: '',
      model_parameters: { useResponsesApi: false },
      skills_enabled: false,
    };
    const created = await request(app()).post('/api/agents').send(agent).expect(204);
    expect(created.status).toBe(204);
    await request(app()).patch('/api/agents/agent_test').send(agent).expect(204);
    await request(app()).get('/api/agents').expect(204);
    await request(app()).get('/api/agents/agent_test/expanded').expect(204);
    await request(app()).get('/api/agents/categories').expect(204);
    await request(app())
      .post('/api/agents/agent_test/revert')
      .send({ version_index: 0 })
      .expect(204);
    await request(app())
      .post('/api/agents/chat')
      .send({
        endpoint: 'agents',
        agent_id: 'agent_test',
        endpointType: 'agents',
        text: 'Hello',
      })
      .expect(204);
  });

  it.each([
    {},
    { version_index: -1 },
    { version_index: 0.5 },
    { version_index: '0' },
    { version_index: null },
    { version_index: 0, tools: ['execute_code'] },
    { version_index: 0, provider: 'openAI' },
  ])('rejects malformed or extended agent restore requests %j', async (body) => {
    const response = await request(app())
      .post('/api/agents/agent_test/revert')
      .send(body)
      .expect(403);
    expect(response.body.type).toBe('governance_feature_unsupported');
  });

  it.each(['get', 'patch', 'delete'] as const)(
    'does not enable other methods on the restore route: %s',
    async (method) => {
      const response = await request(app())
        [method]('/api/agents/agent_test/revert')
        .send({ version_index: 0 })
        .expect(403);
      expect(response.body.type).toBe('governance_feature_unsupported');
    },
  );

  it.each([
    { provider: 'openAI' },
    { tools: ['execute_code'] },
    { tools: ['unknown'] },
    { capabilities: ['unknown'] },
    { model_parameters: { useResponsesApi: true } },
    { tool_options: { shell: true } },
    { subagents: { enabled: true } },
  ])('denies executable Agent Builder settings %j', async (extra) => {
    const denied = await request(app())
      .post('/api/agents')
      .send({
        provider: GOVERNANCE_ENDPOINT,
        model: 'logical-model',
        ...extra,
      })
      .expect(403);
    expect(denied.body.type).toBe('governance_feature_unsupported');
  });

  it.each(['', '   '])('rejects documents without typed text: %j', async (text) => {
    process.env.GOVERNANCE_ATTACHMENTS_ENABLED = 'true';
    await expect(
      request(app())
        .post(chatPath)
        .send({ ...plain, text, files: [{ file_id: 'uploaded' }] }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it.each([true, false])(
    'accepts saved-agent message attachments only when enabled: %s',
    async (enabled) => {
      process.env.GOVERNANCE_ATTACHMENTS_ENABLED = String(enabled);
      const response = await request(app())
        .post('/api/agents/chat/agents')
        .send({
          endpoint: EModelEndpoint.agents,
          endpointType: EModelEndpoint.agents,
          agent_id: 'agent_test',
          text: 'Summarize the document',
          files: [{ file_id: 'uploaded' }],
        })
        .expect(enabled ? 204 : 403);
      expect(response.status).toBe(enabled ? 204 : 403);
    },
  );

  it.each([undefined, [], [null], [{}], [{ file_id: '' }], [{ file_id: '   ' }]])(
    'rejects a blank turn without valid uploaded file references: %j',
    async (files) => {
      process.env.GOVERNANCE_ATTACHMENTS_ENABLED = 'true';
      await expect(
        request(app())
          .post(chatPath)
          .send({ ...plain, text: '', files }),
      ).resolves.toMatchObject({ status: 403 });
    },
  );

  it('rejects a document-only turn when attachments are disabled', async () => {
    process.env.GOVERNANCE_ATTACHMENTS_ENABLED = 'false';
    await expect(
      request(app())
        .post(chatPath)
        .send({ ...plain, text: '', files: [{ file_id: 'uploaded' }] }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it.each([
    {},
    { agent_id: Constants.EPHEMERAL_AGENT_ID },
    { disableStreaming: false },
    { endpointOption: { modelOptions: { disableStreaming: false } } },
    { files: [], tools: [], ephemeralAgent: { web_search: false, mcp: [] } },
    { conversationId: 'existing', parentMessageId: 'reply', isRegenerate: false },
    { addedConvo: { endpoint: GOVERNANCE_ENDPOINT, endpointType: 'custom', model: 'other-model' } },
    { addedConvo: { endpoint: GOVERNANCE_ENDPOINT, model: 'other-model', messages: ['saved-id'] } },
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
    '/api/user/plugins',
    '/api/user/settings/skills/active',
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
    { addedConvo: { endpoint: 'external', model: 'other' } },
    { addedConvo: { endpoint: GOVERNANCE_ENDPOINT, agent_id: 'agent_saved' } },
    { addedConvo: { endpoint: GOVERNANCE_ENDPOINT, tools: ['web_search'] } },
    { editedContent: { text: 'edited' } },
    { useResponsesApi: true },
    { disableStreaming: true },
    { model_parameters: { disableStreaming: true } },
    { endpointOption: { modelOptions: { disableStreaming: true } } },
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
    '/api/user/plugins',
    '/api/user/settings/skills/active',
    '/api/agents/chat/active',
    '/api/agents/chat/stream/job',
    '/api/agents/chat/status/convo',
  ])('preserves read-only history, config, and stream controls: %s', async (path) => {
    await expect(request(app()).get(path)).resolves.toMatchObject({ status: 204 });
  });

  it.each([
    '/api/admin/config',
    '/api/admin/roles',
    '/api/admin/grants',
    '/api/admin/grants/effective',
    '/api/admin/users/search',
    '/api/admin/users',
    '/api/admin/audit-log',
    '/api/admin/login/local',
  ])('denies hidden admin API %s', async (path) => {
    await expect(request(app()).get(path)).resolves.toMatchObject({ status: 403 });
  });

  it.each([
    '/api/admin/verify',
    '/api/admin/groups/capabilities',
    '/api/admin/groups/users/search',
    '/api/admin/groups',
    '/api/admin/oauth/openid/check',
  ])('retains group/session API %s', async (path) => {
    await expect(request(app()).get(path)).resolves.toMatchObject({ status: 204 });
  });

  it.each(['/api/user/terms/accept', '/api/user/settings/favorites'])(
    'preserves ordinary account mutations: %s',
    async (path) => {
      await expect(request(app()).post(path).send({})).resolves.toMatchObject({ status: 204 });
    },
  );

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
  it('blocks integration endpoints', async () => {
    for (const path of ['/api/mcp', '/api/agents/v1', '/api/files/speech/tts']) {
      await expect(request(app()).get(path)).resolves.toMatchObject({ status: 403 });
    }
  });
  it('allows reading a generated title but blocks other title and import requests', async () => {
    await expect(request(app()).get('/api/convos/gen_title/id')).resolves.toMatchObject({
      status: 204,
    });
    await expect(request(app()).post('/api/convos/gen_title/id').send({})).resolves.toMatchObject({
      status: 403,
    });
    await expect(request(app()).post('/api/convos/import').send({})).resolves.toMatchObject({
      status: 403,
    });
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
  function historyApp(getMessages: Parameters<typeof createGovernanceHistoryGuard>[0]) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'user-1' } });
      next();
    });
    server.use(createGovernanceHistoryGuard(getMessages));
    server.use((_req, res) => {
      res.sendStatus(204);
    });
    return server;
  }

  it.each([{ content: [{ type: 'text', text: 'Saved text' }] }, { text: 'Saved text' }])(
    'preserves text-only history: %j',
    async (content) => {
      const message = { messageId: 'root', parentMessageId: null, ...content };
      await expect(
        request(historyApp(async () => [message]))
          .post('/')
          .send({ conversationId: 'existing', parentMessageId: 'root' }),
      ).resolves.toMatchObject({ status: 204 });
    },
  );

  it.each([
    { files: [{ file_id: 'f' }] },
    { attachments: [{ file_id: 'f' }] },
    { content: [{ type: 'tool_call', tool_call: { name: 'web' } }] },
    { content: [{ type: 'image_url' }] },
    { content: [null] },
  ])('rejects historical files/tool content before initialization: %j', async (content) => {
    const message = { messageId: 'root', parentMessageId: null, ...content };
    const server = historyApp(async (filter, select) => {
      expect(filter).toEqual({ conversationId: 'existing', user: 'user-1' });
      expect(select).toBe('messageId parentMessageId text content files attachments');
      return [message];
    });
    await expect(
      request(server).post('/').send({ conversationId: 'existing', parentMessageId: 'root' }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it('allows a clean branch when a sibling contains unsupported content', async () => {
    const messages = [
      { messageId: 'root', parentMessageId: null, text: 'Start' },
      { messageId: 'clean', parentMessageId: 'root', text: 'Text only' },
      { messageId: 'file-branch', parentMessageId: 'root', files: [{ file_id: 'f' }] },
    ];
    const server = historyApp(async () => messages);
    await expect(
      request(server).post('/').send({ conversationId: 'existing', parentMessageId: 'clean' }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      request(server)
        .post('/')
        .send({ conversationId: 'existing', parentMessageId: 'file-branch' }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it('rejects unsupported content on a selected ancestor', async () => {
    const messages = [
      { messageId: 'root', parentMessageId: null, files: [{ file_id: 'f' }] },
      { messageId: 'child', parentMessageId: 'root', text: 'Text only' },
    ];
    await expect(
      request(historyApp(async () => messages))
        .post('/')
        .send({ conversationId: 'existing', parentMessageId: 'child' }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it.each([
    { parentMessageId: 'missing', messages: [] },
    {
      parentMessageId: 'loop-a',
      messages: [
        { messageId: 'loop-a', parentMessageId: 'loop-b' },
        { messageId: 'loop-b', parentMessageId: 'loop-a' },
      ],
    },
  ])(
    'rejects an incomplete or cyclic selected branch: %j',
    async ({ parentMessageId, messages }) => {
      await expect(
        request(historyApp(async () => messages))
          .post('/')
          .send({ conversationId: 'existing', parentMessageId }),
      ).resolves.toMatchObject({ status: 403 });
    },
  );
});

describe('pilot configuration', () => {
  it.each([true, false])(
    'applies the same governed attachment settings to saved agents and classic chat: %s',
    (enabled) => {
      process.env.GOVERNANCE_ATTACHMENTS_ENABLED = String(enabled);
      const config = restrictGovernanceConfig({});
      const endpoints = config.fileConfig?.endpoints;

      expect(endpoints?.agents).toEqual(endpoints?.[GOVERNANCE_ENDPOINT]);
      expect(endpoints?.agents).toMatchObject({ disabled: !enabled });
      expect(endpoints?.default?.disabled).toBe(true);
      expect(config.endpoints?.agents?.capabilities).toEqual([]);
      if (enabled) {
        expect(endpoints?.agents).toMatchObject({
          fileLimit: 10,
          fileSizeLimit: 20,
          totalSizeLimit: 50,
          supportedMimeTypes: config.fileConfig?.text?.supportedMimeTypes,
        });
      }
    },
  );

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
      agents: { use: true, create: true, share: false, public: false },
      webSearch: false,
    });
    expect(result.mcpConfig).toBeNull();
    expect(result.availableTools).toEqual({});
    expect(result.memory).toBeUndefined();
    expect(result.summarization?.enabled).toBe(false);
  });

  it('keeps only the configured title settings on the governed endpoint', () => {
    const config = restrictGovernanceConfig({
      endpoints: {
        custom: [
          {
            name: GOVERNANCE_ENDPOINT,
            apiKey: 'user_provided',
            baseURL: 'https://external.test',
            models: { default: ['model'] },
            titleConvo: true,
            titleModel: 'title-model',
            titleTiming: 'final',
            titlePrompt: 'Title: {convo}',
            titleEndpoint: 'openAI',
          } as NonNullable<NonNullable<AppConfig['config']['endpoints']>['custom']>[number],
        ],
      },
    });
    const governed = config.endpoints?.custom?.[0];
    expect(governed).toMatchObject({
      apiKey: '${LIBRECHAT_SERVICE_CREDENTIAL}',
      baseURL: '${GOVERNANCE_API_BASE_URL}',
      titleConvo: true,
      titleModel: 'title-model',
      titleTiming: 'final',
      titlePrompt: 'Title: {convo}',
    });
    expect(governed).not.toHaveProperty('titleEndpoint');
    expect(restrictGovernanceConfig(config).endpoints?.custom?.[0]).toEqual(governed);
  });

  it('overrides derived admin configuration and preserves unrelated settings', () => {
    const base: AppConfig = {
      config: {
        interface: {
          contextUsage: true,
          privacyPolicy: { externalUrl: 'https://old.example/privacy' },
        },
      },
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      interfaceConfig: {
        agents: true,
        modelSelect: false,
        contextUsage: false,
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
        termsOfService: { externalUrl: 'https://example.com/terms' },
      },
      endpoints: { openAI: { titleConvo: true } },
      registration: { socialLogins: ['openid'] },
    };
    const result = restrictGovernanceAppConfig(base);
    expect(result.endpoints?.openAI).toBeUndefined();
    expect(result.interfaceConfig).toMatchObject({
      agents: { use: true, create: true, share: false, public: false },
      modelSelect: true,
      contextUsage: false,
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      termsOfService: { externalUrl: 'https://example.com/terms' },
    });
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
    expect(Object.keys(endpoints ?? {})).toEqual([GOVERNANCE_ENDPOINT, 'agents']);
    expect(endpoints?.[GOVERNANCE_ENDPOINT]).toMatchObject({ type: 'custom', userProvide: false });
    expect(await services.checkCapability(req, AgentCapabilities.tools)).toBe(false);
    expect(await services.checkCapability(req, AgentCapabilities.skills)).toBe(false);
  });

  it('rejects external moderation at startup', () => {
    process.env.OPENAI_MODERATION = 'true';
    expect(() => restrictGovernanceConfig({})).toThrow(/moderation/);
  });
  it.each([undefined, '', 'false', 'FALSE', '0'])(
    'rejects pilot startup when OpenID token reuse is %j',
    (value) => {
      if (value === undefined) delete process.env.OPENID_REUSE_TOKENS;
      else process.env.OPENID_REUSE_TOKENS = value;

      expect(() => restrictGovernanceConfig({})).toThrow(/OPENID_REUSE_TOKENS/);
    },
  );
  it.each(['true', 'TRUE', ' True '])('accepts OpenID token reuse %j', (value) => {
    process.env.OPENID_REUSE_TOKENS = value;

    expect(() => restrictGovernanceConfig({})).not.toThrow();
  });
  it.each(['OPENID_ADMIN_ROLE', 'OPENID_ADMIN_ROLE_PARAMETER_PATH'])(
    'rejects pilot startup without %s',
    (key) => {
      delete process.env[key];

      expect(() => restrictGovernanceConfig({})).toThrow(key);
    },
  );
  it.each(['', '   '])('rejects blank administrator role %j at startup', (value) => {
    process.env.OPENID_ADMIN_ROLE = value;

    expect(() => restrictGovernanceConfig({})).toThrow('OPENID_ADMIN_ROLE');
  });
  it('does not change non-pilot configuration', () => {
    delete process.env.GOVERNANCE_PILOT_ENABLED;
    process.env.OPENID_REUSE_TOKENS = 'false';
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
  beforeEach(() => {
    process.env.GOVERNANCE_API_BASE_URL = 'http://gateway.test/v1';
  });
  it.each([
    ['https://external.test/v1/chat/completions', valid],
    ['http://gateway.test/v1/responses', valid],
    ['http://gateway.test:8080/v1/chat/completions', valid],
    ['http://gateway.test/v2/chat/completions', valid],
    ['http://gateway.test/v1/chat/completions?extra=true', valid],
    ['http://gateway.test/v1/models', valid],
    ['http://gateway.test/v1/chat/completions', { ...valid, stream: 'yes' }],
    ['http://gateway.test/v1/chat/completions', { ...valid, tools: [{ type: 'function' }] }],
    [
      'http://gateway.test/v1/chat/completions',
      { ...valid, messages: [{ role: 'tool', content: 'result' }] },
    ],
  ])('never forwards unsupported destination or request %s %j', async (url, body) => {
    const fetch = jest.fn();
    const governed = createGovernanceDlpFetch({ userId: 'user-1', fetch });
    const response = await governed(url, { method: 'POST', body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'dlp_unsupported_request' } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['http://gateway.test/v1', 'http://gateway.test/v1/chat/completions'],
    ['HTTP://GATEWAY.TEST/v1/', 'http://gateway.test/v1/chat/completions'],
    ['http://gateway.test:80/v1', 'http://gateway.test/v1/chat/completions'],
    ['HTTPS://GATEWAY.TEST:443/v1///', 'https://gateway.test/v1/chat/completions'],
  ])('preserves streaming and the request body with gateway URL %s', async (base, destination) => {
    process.env.GOVERNANCE_API_BASE_URL = base;
    const upstream = new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-LibreChat-User-ID')).toBe('user-1');
      expect(JSON.parse(String(init?.body))).toEqual(valid);
      return upstream;
    });
    const governed = createGovernanceDlpFetch({ userId: 'user-1', fetch });
    expect(
      await governed(destination, {
        method: 'POST',
        body: JSON.stringify(valid),
      }),
    ).toBe(upstream);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('forwards a non-streaming title request to the governed endpoint', async () => {
    const title = { ...valid, stream: false };
    const upstream = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    const fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-LibreChat-User-ID')).toBe('user-1');
      expect(JSON.parse(String(init?.body))).toEqual(title);
      return upstream;
    });
    const governed = createGovernanceDlpFetch({ userId: 'user-1', fetch });
    expect(
      await governed('http://gateway.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(title),
      }),
    ).toBe(upstream);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
