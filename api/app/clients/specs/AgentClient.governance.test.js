const http = require('node:http');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Providers } = require('@librechat/agents');
const {
  Tokenizer,
  MCPManager,
  MCPServersRegistry,
  createGovernanceDlpFetch,
} = require('@librechat/api');
const { Constants, ContentTypes, EModelEndpoint } = require('librechat-data-provider');
const AgentClient = require('~/server/controllers/agents/client');
const checkGovernanceDlp = require('~/server/middleware/checkGovernanceDlp');
const { Message, Conversation } = require('~/db/models');

jest.unmock('~/config');

describe('characterization: completion-level governance rejection retains history', () => {
  const blockedText = 'Email: jane@example.com';
  const cleanText = 'Tell me a short story.';
  const model = 'gpt-4o-mini';
  const userId = new mongoose.Types.ObjectId().toString();
  const originalEnvironment = {
    GOVERNANCE_DLP_ENABLED: process.env.GOVERNANCE_DLP_ENABLED,
    GOVERNANCE_API_BASE_URL: process.env.GOVERNANCE_API_BASE_URL,
    LIBRECHAT_SERVICE_CREDENTIAL: process.env.LIBRECHAT_SERVICE_CREDENTIAL,
  };
  let mongoServer;
  let gateway;
  let gatewayUrl;
  let requests;
  let followupDecision;
  let completionCount;

  beforeAll(async () => {
    // The real encoding is loaded via dynamic import(), which CI's Jest cannot run without
    // --experimental-vm-modules; token counts don't affect these assertions.
    jest.spyOn(Tokenizer, 'initEncoding').mockResolvedValue(undefined);
    jest
      .spyOn(Tokenizer, 'getTokenCount')
      .mockImplementation((text = '') => Math.ceil(String(text).length / 4));
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    MCPServersRegistry.createInstance(mongoose);
    await MCPManager.createInstance({});
    gateway = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const recorded = { path: req.url, body, token: req.headers['x-dlp-token'] };
      requests.push(recorded);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/dlp/check') {
        const retainedHistory = body.messages.some((message) => message.content === blockedText);
        const action = completionCount > 0 && retainedHistory ? followupDecision : 'ALLOW';
        recorded.action = action;
        res.end(JSON.stringify({ action, findings: [], dlp_token: 'fixture-token' }));
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      completionCount++;
      if (completionCount === 1) {
        res.writeHead(403).end(
          JSON.stringify({
            error: {
              message: 'governance_blocked',
              type: 'governance_blocked',
              code: 'governance_blocked',
            },
          }),
        );
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(
        `data: ${JSON.stringify({
          id: 'fixture-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null },
          ],
        })}\n\ndata: ${JSON.stringify({
          id: 'fixture-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
    process.env.GOVERNANCE_DLP_ENABLED = 'true';
    process.env.GOVERNANCE_API_BASE_URL = `${gatewayUrl}/v1`;
    process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'fixture-credential';
  }, 600000);

  beforeEach(async () => {
    await Promise.all([Message.deleteMany({}), Conversation.deleteMany({})]);
    requests = [];
    completionCount = 0;
    followupDecision = 'BLOCK';
  });

  afterAll(async () => {
    if (gateway) {
      await new Promise((resolve) => {
        gateway.close(resolve);
        gateway.closeAllConnections();
      });
    }
    await mongoose.disconnect();
    await mongoServer?.stop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  async function send(text, conversationId, parentMessageId = Constants.NO_PARENT) {
    const req = {
      user: { id: userId, personalization: { memories: false } },
      body: { text, model, conversationId },
      config: {
        endpoints: {},
        memory: { disabled: true },
        balance: { enabled: false },
        transactions: { enabled: false },
      },
    };
    const next = jest.fn();
    await checkGovernanceDlp(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.governanceDlpEligible).toBe(true);
    const client = new AgentClient({
      req,
      res: {},
      endpoint: EModelEndpoint.openAI,
      sender: 'Assistant',
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      maxContextTokens: 8192,
      agent: {
        id: `openAI__${model}`,
        provider: Providers.OPENAI,
        endpoint: EModelEndpoint.openAI,
        tools: [],
        instructions: '',
        useLegacyContent: true,
        model_parameters: {
          model,
          apiKey: 'fixture-credential',
          maxRetries: 0,
          configuration: {
            baseURL: `${gatewayUrl}/v1`,
            fetch: createGovernanceDlpFetch({ userId }),
          },
        },
      },
    });
    const response = await client.sendMessage(text, {
      user: userId,
      conversationId,
      parentMessageId,
    });
    await response.databasePromise;
    return response;
  }

  async function rejectFirstCompletion() {
    const conversationId = randomUUID();
    const response = await send(blockedText, conversationId);
    expect(completionCount).toBe(1);
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: ContentTypes.ERROR,
          error: expect.stringContaining('403'),
        }),
      ]),
    );
    const persisted = await Message.findOne({ messageId: response.parentMessageId }).lean();
    expect(persisted).toMatchObject({ text: blockedText, conversationId, isCreatedByUser: true });
    expect(await Message.exists({ messageId: response.messageId })).toBeTruthy();
    expect(await Conversation.exists({ conversationId })).toBeTruthy();
    expect(requests.map(({ path }) => path)).toEqual([
      '/api/v1/dlp/check',
      '/api/v1/dlp/check',
      '/v1/chat/completions',
    ]);
    expect(requests[0].action).toBe('ALLOW');
    expect(requests[1].action).toBe('ALLOW');
    expect(requests[2].token).toBe('fixture-token');
    return response;
  }

  function expectRetainedHistory(body) {
    const userContents = body.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    expect(userContents).toEqual([blockedText, cleanText]);
  }

  it('retained-history detected at preflight: no second completion is sent', async () => {
    const rejected = await rejectFirstCompletion();
    await send(cleanText, rejected.conversationId, rejected.messageId);
    expectRetainedHistory(requests.at(-1).body);
    expect(requests.at(-1).path).toBe('/api/v1/dlp/check');
    expect(requests.at(-1).action).toBe('BLOCK');
    expect(completionCount).toBe(1);
  });

  it('retained content reaches completion payload when preflight deliberately allows it', async () => {
    const rejected = await rejectFirstCompletion();
    // Controlled ALLOW fixture tests forwarding, not realistic policy for retained blocked content.
    followupDecision = 'ALLOW';
    await send(cleanText, rejected.conversationId, rejected.messageId);
    const check = requests.at(-2);
    const completion = requests.at(-1);
    expect(check.path).toBe('/api/v1/dlp/check');
    expect(check.action).toBe('ALLOW');
    expect(completion.path).toBe('/v1/chat/completions');
    expectRetainedHistory(check.body);
    expectRetainedHistory(completion.body);
    expect(completion.body).toEqual(check.body);
    expect(completion.token).toBe('fixture-token');
    expect(completionCount).toBe(2);
  });
});
