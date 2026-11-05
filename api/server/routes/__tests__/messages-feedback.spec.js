const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/agents', () => ({
  sleep: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
}));

jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  return createMethods(mongoose);
});

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  validateMessageReq: (req, res, next) => next(),
}));

const { createModels } = require('@librechat/data-schemas');
const { sendFeedbackScore } = require('@librechat/api');

describe('PUT /:conversationId/:messageId/feedback', () => {
  const userId = 'user-feedback-1';
  const conversationId = 'convo-feedback-1';
  const first = 'openAI__gpt-4.1___GPT-4.1____0';
  const second = 'anthropic__claude-3.5___Claude____1';
  let mongoServer;
  let Message;
  let app;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    Object.assign(mongoose.models, createModels(mongoose));
    Message = mongoose.models.Message;
    await mongoose.connect(mongoServer.getUri());

    const messagesRouter = require('../messages');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: userId };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Message.deleteMany({});
    await Message.create({
      messageId: 'comparison-1',
      conversationId,
      user: userId,
      isCreatedByUser: false,
      endpoint: 'agents',
      content: [
        { type: 'text', text: 'First answer', agentId: first, groupId: 1 },
        { type: 'text', text: 'Second answer', agentId: second, groupId: 1 },
      ],
    });
  });

  const sendFeedback = (body) =>
    request(app).put(`/api/messages/${conversationId}/comparison-1/feedback`).send(body);

  const stored = () => Message.findOne({ messageId: 'comparison-1' }).lean();

  it('rates each comparison response on its own', async () => {
    const response = await sendFeedback({
      agentId: first,
      feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' },
    });
    await sendFeedback({ agentId: second, feedback: { rating: 'thumbsDown', tag: 'not_helpful' } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      messageId: 'comparison-1',
      conversationId,
      agentId: first,
      feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' },
    });
    const message = await stored();
    expect(message.parallelFeedback).toEqual([
      { agentId: first, rating: 'thumbsUp', tag: 'accurate_reliable' },
      { agentId: second, rating: 'thumbsDown', tag: 'not_helpful' },
    ]);
    expect(message.feedback).toBeUndefined();
    expect(sendFeedbackScore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        traceId: 'trace-comparison-1',
        agentId: second,
        feedback: { rating: 'thumbsDown', tag: 'not_helpful' },
      }),
    );
  });

  it("clears one response's rating when its feedback is removed", async () => {
    await sendFeedback({ agentId: first, feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' } });
    await sendFeedback({ agentId: second, feedback: { rating: 'thumbsDown', tag: 'not_helpful' } });

    const response = await sendFeedback({ agentId: first });

    expect(response.status).toBe(200);
    expect(response.body.feedback).toBeUndefined();
    expect((await stored()).parallelFeedback).toEqual([
      { agentId: second, rating: 'thumbsDown', tag: 'not_helpful' },
    ]);
  });

  it.each([
    ['an unknown rating', { agentId: first, feedback: { rating: 'meh', tag: 'other' } }],
    ['an empty agent ID', { agentId: '', feedback: { rating: 'thumbsUp', tag: 'other' } }],
  ])('rejects %s', async (_label, body) => {
    const response = await sendFeedback(body);

    expect(response.status).toBe(400);
    expect((await stored()).parallelFeedback).toBeUndefined();
  });

  it('answers 404 for an agent that has no response in the message', async () => {
    const response = await sendFeedback({
      agentId: 'other-agent',
      feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' },
    });

    expect(response.status).toBe(404);
    expect((await stored()).parallelFeedback).toBeUndefined();
    expect(sendFeedbackScore).not.toHaveBeenCalled();
  });

  it('still rates the whole message without an agent ID', async () => {
    const response = await sendFeedback({
      feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
    });

    expect(response.status).toBe(200);
    const message = await stored();
    expect(message.feedback).toMatchObject({ rating: 'thumbsDown', tag: 'inaccurate' });
    expect(message.parallelFeedback).toBeUndefined();
    expect(sendFeedbackScore).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'trace-comparison-1', agentId: undefined }),
    );
  });
});
