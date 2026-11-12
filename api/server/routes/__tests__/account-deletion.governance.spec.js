const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/cache', () => ({ getLogStores: require('~/cache/getLogStores') }));
jest.mock('~/cache/getLogStores', () => () => ({
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
}));
jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware', () => ({
  ...require('../__test-utils__/convos-route-mocks').middlewarePassthrough(),
  requireJwtAuth: require('~/server/middleware/requireJwtAuth'),
  canDeleteAccount: require('~/server/middleware/canDeleteAccount'),
  validateMessageReq: require('~/server/middleware/validateMessageReq'),
  verifyEmailLimiter: (req, res, next) => next(),
}));
jest.mock('../settings', () => require('express').Router());
jest.mock('~/server/controllers/UserController', () => ({
  deleteUserController: jest.fn((req, res) => res.sendStatus(204)),
  getUserController: jest.fn(),
  updateUserPluginsController: jest.fn(),
  resendVerificationController: jest.fn(),
  getTermsStatusController: jest.fn(),
  acceptTermsController: jest.fn(),
  verifyEmailController: jest.fn(),
}));
jest.mock('~/server/utils/import/fork', () =>
  require('../__test-utils__/convos-route-mocks').forkUtils(),
);
jest.mock('~/server/utils/import', () =>
  require('../__test-utils__/convos-route-mocks').importUtils(),
);
jest.mock('~/server/routes/files/multer', () =>
  require('../__test-utils__/convos-route-mocks').multerSetup(),
);
jest.mock('multer', () => require('../__test-utils__/convos-route-mocks').multerLib());
jest.mock('~/server/services/Endpoints/azureAssistants', () => ({ initializeClient: jest.fn() }));
jest.mock('~/server/services/Endpoints/assistants', () => ({ initializeClient: jest.fn() }));

const { User, Conversation, Message } = require('~/db/models');
const { deleteUserController } = require('~/server/controllers/UserController');
const app = express();
let user;
let mongo;
const originalEnv = {
  ALLOW_ACCOUNT_DELETION: process.env.ALLOW_ACCOUNT_DELETION,
  GOVERNANCE_PILOT_ENABLED: process.env.GOVERNANCE_PILOT_ENABLED,
};

app.use(express.json());
app.use((req, res, next) => {
  req.user = { id: user.id, role: user.role };
  next();
});
app.use('/api/user', require('../user'));
app.use('/api/messages', require('../messages'));
app.use('/api/convos', require('../convos'));

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { runtimeDownload: false } });
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  process.env.ALLOW_ACCOUNT_DELETION = 'false';
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
  user = await User.create({ email: 'employee@example.test', provider: 'openid', role: 'USER' });
  await Conversation.create({
    conversationId: 'owned-conversation',
    user: user.id,
    endpoint: 'custom',
  });
  await Message.create({
    messageId: 'owned-message',
    conversationId: 'owned-conversation',
    user: user.id,
    text: 'Employee message',
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

it('rejects ordinary-user account deletion before the controller and preserves data', async () => {
  const response = await request(app).delete('/api/user/delete');
  expect(response.status).toBe(403);
  expect(response.body.message).toBe('You do not have permission to delete this account');
  expect(deleteUserController).not.toHaveBeenCalled();
  expect(await User.exists({ _id: user.id })).not.toBeNull();
  expect(await Conversation.countDocuments({ user: user.id })).toBe(1);
  expect(await Message.countDocuments({ user: user.id })).toBe(1);
});

it('still deletes an owned message while account deletion is disabled', async () => {
  const response = await request(app).delete('/api/messages/owned-conversation/owned-message');
  expect(response.status).toBe(204);
  expect(await Message.countDocuments({ user: user.id })).toBe(0);
  expect(await Conversation.countDocuments({ user: user.id })).toBe(1);
  expect(await User.exists({ _id: user.id })).not.toBeNull();
});

it('still deletes an owned conversation and its messages while account deletion is disabled', async () => {
  const response = await request(app)
    .delete('/api/convos')
    .send({ arg: { conversationId: 'owned-conversation' } });
  expect(response.status).toBe(201);
  expect(await Conversation.countDocuments({ user: user.id })).toBe(0);
  expect(await Message.countDocuments({ user: user.id })).toBe(0);
  expect(await User.exists({ _id: user.id })).not.toBeNull();
});
