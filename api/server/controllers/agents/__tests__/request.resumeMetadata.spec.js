const { EventEmitter } = require('events');
const { Constants } = require('librechat-data-provider');

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockGenerationJobManager = {
  getJob: jest.fn(),
  createJob: jest.fn(),
  emitDone: jest.fn(),
  emitChunk: jest.fn(),
  emitError: jest.fn(),
  completeJob: jest.fn(),
  getResumeState: jest.fn(),
  updateMetadata: jest.fn(),
};

const mockCheckAndIncrementPendingRequest = jest.fn();
const mockDecrementPendingRequest = jest.fn();
const mockFilterPersistableAbortContent = jest.fn((content) =>
  content.filter((part) => part?.type !== 'tool_call'),
);
const mockGetConvo = jest.fn();
const mockGetMessages = jest.fn();
const mockSaveMessage = jest.fn();
let mockMCPContexts = new WeakMap();

const mockCreateMCPRequestContext = jest.fn(() => ({
  connections: new Map(),
  pending: new Map(),
  cleanupStarted: false,
  cleanupOnResponse: false,
  responseCleanupAttached: false,
}));
const mockGetMCPRequestContext = jest.fn((req) => {
  if (!req) {
    return undefined;
  }

  let context = mockMCPContexts.get(req);
  if (!context) {
    context = mockCreateMCPRequestContext();
    mockMCPContexts.set(req, context);
  }

  return context.cleanupStarted ? undefined : context;
});
const mockCleanupMCPRequestContext = jest.fn(async (context) => {
  if (!context || context.cleanupStarted) {
    return;
  }

  context.cleanupStarted = true;
  const connections = new Set(context.connections.values());
  const settled = await Promise.allSettled(context.pending.values());
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      connections.add(result.value);
    }
  }

  await Promise.allSettled(Array.from(connections).map((connection) => connection.disconnect?.()));
  context.connections.clear();
  context.pending.clear();
});
const mockCleanupMCPRequestContextForReq = jest.fn(async (req) => {
  const context = mockMCPContexts.get(req);
  if (!context) {
    return;
  }

  try {
    await mockCleanupMCPRequestContext(context);
  } finally {
    mockMCPContexts.delete(req);
  }
});

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  onDlpSent: (...args) => jest.requireActual('@librechat/api').onDlpSent(...args),
  isDlpUnsent: (...args) => jest.requireActual('@librechat/api').isDlpUnsent(...args),
  getViolationInfo: jest.fn(),
  buildMessageFiles: jest.fn(() => []),
  resolveTitleTiming: jest.fn(() => 'immediate'),
  GenerationJobManager: mockGenerationJobManager,
  getReferencedQuotes: jest.fn((quotes) => {
    if (!Array.isArray(quotes)) {
      return null;
    }
    const normalized = quotes
      .filter((quote) => typeof quote === 'string' && quote.trim().length > 0)
      .map((quote) => quote.trim());
    return normalized.length > 0 ? normalized : null;
  }),
  cleanupMCPRequestContext: (...args) => mockCleanupMCPRequestContext(...args),
  createMCPRequestContext: (...args) => mockCreateMCPRequestContext(...args),
  getMCPRequestContext: (...args) => mockGetMCPRequestContext(...args),
  filterPersistableAbortContent: (...args) => mockFilterPersistableAbortContent(...args),
  cleanupMCPRequestContextForReq: (...args) => mockCleanupMCPRequestContextForReq(...args),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  isUnpersistedPreliminaryParent: async ({
    userId,
    conversationId,
    parentMessageId,
    getMessages,
  }) => {
    if (typeof parentMessageId !== 'string' || !parentMessageId.endsWith('_')) {
      return false;
    }

    const filter = { user: userId, messageId: parentMessageId };
    if (conversationId && conversationId !== 'new') {
      filter.conversationId = conversationId;
    }

    const messages = await getMessages(filter, '_id');
    return messages.length === 0;
  },
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
  clientRegistry: null,
  requestDataMap: {
    set: jest.fn(),
  },
}));

jest.mock('~/server/middleware', () => ({
  handleAbortError: jest.fn(() => Promise.resolve()),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

const AgentController = require('../request');
const { getMCPRequestContext } = require('~/server/services/MCPRequestContext');

function createResumableResponse() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.finished = false;
  res.destroyed = false;
  res.json = jest.fn(() => {
    res.headersSent = true;
    res.writableEnded = true;
    res.finished = true;
    res.emit('finish');
    return res;
  });
  res.status = jest.fn(() => res);
  return res;
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ResumableAgentController resume metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMCPContexts = new WeakMap();
    mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: true });
    mockDecrementPendingRequest.mockResolvedValue(undefined);
    mockGetConvo.mockResolvedValue({ createdAt: '2026-06-07T00:00:00.000Z' });
    mockGetMessages.mockResolvedValue([]);
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: { on: jest.fn() },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue(null);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.emitError.mockResolvedValue(undefined);
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1000 });
    mockGenerationJobManager.emitDone.mockResolvedValue(undefined);
    mockSaveMessage.mockResolvedValue({});
  });

  it('rejects an underscore-suffixed parent that is not persisted', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn();
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Follow up too early.',
        messageId: 'follow-up-user',
        parentMessageId: 'pending-response_',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      { user: 'user-123', messageId: 'pending-response_', conversationId },
      '_id',
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('selected parent response is still being saved'),
      }),
    );
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('allows an underscore-suffixed parent when it is already persisted', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([{ _id: 'persisted-parent' }]);
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Follow up to persisted underscore id.',
        messageId: 'follow-up-user',
        parentMessageId: 'persisted-response_',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      { user: 'user-123', messageId: 'persisted-response_', conversationId },
      '_id',
    );
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
    );
  });

  it('stores the in-flight turn before MCP initialization can emit OAuth', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Check Google Workspace availability.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          iconURL: 'https://example.com/spec-icon.png',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        conversationId,
        endpoint: 'agents',
        iconURL: 'https://example.com/spec-icon.png',
        model: 'gpt-3.5-turbo',
        responseMessageId: 'follow-up-user_',
        userMessage: {
          messageId: 'follow-up-user',
          parentMessageId: 'original-response',
          conversationId,
          text: 'Check Google Workspace availability.',
        },
      }),
    );
    expect(mockGenerationJobManager.updateMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      initializeClient.mock.invocationCallOrder[0],
    );
  });

  it('keeps request-scoped MCP connections until resumable initialization finishes', async () => {
    const conversationId = 'conversation-123';
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const initializeClient = jest.fn(async ({ req, res }) => {
      const context = getMCPRequestContext(req, res);
      context.connections.set('mcp-server', { disconnect });

      await nextTick();
      expect(disconnect).not.toHaveBeenCalled();

      throw new Error('stop after request-scoped MCP connection');
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use a BODY-scoped MCP server.',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-4.1' },
        },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: conversationId,
      conversationId,
      status: 'started',
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockDecrementPendingRequest.mock.invocationCallOrder[0],
    );
  });

  it('stores model spec icon fallbacks and agent ids in early resume metadata', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use the resume spec.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'agent-spec',
          agent_id: 'agent_resume_spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'agent-spec',
              preset: {
                endpoint: 'openAI',
                iconURL: 'https://example.com/preset-icon.png',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        iconURL: 'https://example.com/preset-icon.png',
        model: 'agent_resume_spec',
      }),
    );
  });

  it('falls back to the model spec preset endpoint when no icon URL is configured', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use the endpoint icon.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'endpoint-icon-spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'endpoint-icon-spec',
              preset: {
                endpoint: 'anthropic',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        iconURL: 'anthropic',
        model: 'gpt-4.1',
      }),
    );
  });

  it('filters OAuth prompts before saving partial responses on disconnect', async () => {
    const conversationId = 'conversation-123';
    let allSubscribersLeftHandler;
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue({
      conversationId,
      responseMessageId: 'response-message',
      iconURL: 'https://example.com/spec-icon.png',
      model: 'gpt-4.1',
      userMessage: {
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        text: 'Use Google Workspace',
      },
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use Google Workspace',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          iconURL: 'https://example.com/fallback-icon.png',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));

    const oauthPart = {
      type: 'tool_call',
      tool_call: {
        name: 'oauth_mcp_Google-Workspace',
        auth: 'https://auth.example.com/oauth',
      },
    };
    const textPart = { type: 'text', text: 'Partial response...' };

    await allSubscribersLeftHandler([oauthPart, textPart]);

    expect(mockFilterPersistableAbortContent).toHaveBeenCalledWith([oauthPart, textPart]);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({
        content: [textPart],
        iconURL: 'https://example.com/spec-icon.png',
        model: 'gpt-4.1',
        messageId: 'response-message',
        parentMessageId: 'user-message',
      }),
      expect.any(Object),
    );
  });

  it('uses model spec and agent fallbacks when saving partial responses on disconnect', async () => {
    const conversationId = 'conversation-123';
    let allSubscribersLeftHandler;
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue({
      conversationId,
      responseMessageId: 'response-message',
      userMessage: {
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        text: 'Use fallback metadata',
      },
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use fallback metadata',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'agent-spec',
          agent_id: 'agent_resume_spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'agent-spec',
              preset: {
                endpoint: 'openAI',
                iconURL: 'https://example.com/preset-icon.png',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));

    const textPart = { type: 'text', text: 'Partial response...' };
    await allSubscribersLeftHandler([textPart]);

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({
        content: [textPart],
        iconURL: 'https://example.com/preset-icon.png',
        model: 'agent_resume_spec',
        messageId: 'response-message',
        parentMessageId: 'user-message',
      }),
      expect.any(Object),
    );
  });

  it('announces a governed turn as created only once the gateway starts its completion', async () => {
    const { createRequestDlpFetch } = jest.requireActual('@librechat/api');
    const conversationId = 'conversation-123';
    const userMessage = {
      messageId: 'user-message',
      parentMessageId: 'parent-message',
      conversationId,
      text: 'A governed message',
    };
    let chunksBeforeSent;
    const initializeClient = jest.fn(async ({ req }) => {
      const governedFetch = createRequestDlpFetch(
        req,
        async () =>
          new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      );
      const sendMessage = async (_text, opts) => {
        opts.onStart(userMessage, 'response-message');
        chunksBeforeSent = mockGenerationJobManager.emitChunk.mock.calls.length;
        await governedFetch('http://governance.test/api/v1/dlp/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'governed-model',
            messages: [{ role: 'user', content: userMessage.text }],
            stream: true,
          }),
        });
        throw new Error('stop after the gateway started');
      };
      return { client: { sendMessage } };
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: userMessage.text,
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        conversationId,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'governed-model' } },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);
    for (let i = 0; i < 50 && mockGenerationJobManager.emitError.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(chunksBeforeSent).toBe(0);
    expect(mockGenerationJobManager.emitChunk).toHaveBeenCalledTimes(1);
    expect(mockGenerationJobManager.emitChunk).toHaveBeenCalledWith(conversationId, {
      created: true,
      message: userMessage,
      streamId: conversationId,
    });
    expect(mockGenerationJobManager.emitError).toHaveBeenCalledWith(
      conversationId,
      'stop after the gateway started',
    );
  });

  describe('title timing for a new conversation', () => {
    const text = 'A first message';

    const completion = async () =>
      new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });

    async function runFirstTurn({ governed }) {
      const { createRequestDlpFetch } = jest.requireActual('@librechat/api');
      const addTitle = jest.fn(async () => {});
      let titlesBeforeResponse;
      const initializeClient = jest.fn(async ({ req }) => {
        const modelFetch = governed ? createRequestDlpFetch(req, completion) : completion;
        const sendMessage = async () => {
          await modelFetch('http://governance.test/api/v1/dlp/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'governed-model',
              messages: [{ role: 'user', content: text }],
              stream: true,
            }),
          });
          titlesBeforeResponse = addTitle.mock.calls.length;
          return {
            messageId: 'response-message',
            databasePromise: Promise.resolve({
              conversation: { conversationId: req.body.conversationId },
            }),
          };
        };
        return { client: { sendMessage } };
      });
      const req = {
        user: { id: 'user-123' },
        body: {
          text,
          parentMessageId: Constants.NO_PARENT,
          endpointOption: { endpoint: 'agents', modelOptions: { model: 'governed-model' } },
        },
        config: {},
      };

      await AgentController(req, createResumableResponse(), jest.fn(), initializeClient, addTitle);
      for (let i = 0; i < 50 && mockGenerationJobManager.completeJob.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await nextTick();
      return { req, addTitle, titlesBeforeResponse };
    }

    it('titles a governed turn only after its response', async () => {
      const { req, addTitle, titlesBeforeResponse } = await runFirstTurn({ governed: true });

      expect(titlesBeforeResponse).toBe(0);
      expect(addTitle).toHaveBeenCalledTimes(1);
      expect(addTitle).toHaveBeenCalledWith(req, {
        text,
        response: expect.objectContaining({ messageId: 'response-message' }),
        client: expect.any(Object),
      });
      expect(mockGenerationJobManager.emitDone.mock.invocationCallOrder[0]).toBeLessThan(
        addTitle.mock.invocationCallOrder[0],
      );
    });

    it('keeps titling a turn that is not governed alongside its response', async () => {
      const { req, addTitle, titlesBeforeResponse } = await runFirstTurn({ governed: false });

      expect(titlesBeforeResponse).toBe(1);
      expect(addTitle).toHaveBeenCalledTimes(1);
      expect(addTitle).toHaveBeenCalledWith(
        req,
        expect.objectContaining({ text, immediate: true }),
      );
    });
  });
});
