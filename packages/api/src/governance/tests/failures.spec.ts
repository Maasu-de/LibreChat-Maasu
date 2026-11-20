import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { Keyv } from 'keyv';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import type { FlowStateManager } from '~/flow/manager';

const environment = process.env;
const credentials = {
  CREDS_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  CREDS_IV: '0123456789abcdef0123456789abcdef',
};
let schemas: typeof import('@librechat/data-schemas');
let models: ReturnType<typeof schemas.createModels>;
let methods: ReturnType<typeof schemas.createMethods>;
let OAuth: typeof import('~/mcp/oauth').MCPOAuthHandler;
let FlowManager: typeof import('~/flow/manager').FlowStateManager;
let FlowStorage: typeof import('~/flow/storage').FlowStateStorage;
let staleMs: number;
let csrf: typeof import('~/oauth/csrf');
let handlers: typeof import('../mcp');
const tenantId = 'oauth-tenant';
const serverName = 'remote';
const state = 'opaque-provider-state';
const outbox = () => mongoose.connection.db!.collection('governance_group_audit_outbox');
let mongo: MongoMemoryServer;
let actor: IUser;
let connectionId: string;
let manager: FlowStateManager<MCPOAuthTokens | null>;
let store: Keyv;
let flowId: string;

beforeAll(async () => {
  process.env = { ...environment, ...credentials };
  schemas = await import('@librechat/data-schemas');
  models = schemas.createModels(mongoose);
  methods = schemas.createMethods(mongoose);
  OAuth = (await import('~/mcp/oauth')).MCPOAuthHandler;
  ({ FlowStateManager: FlowManager, PENDING_STALE_MS: staleMs } = await import('~/flow/manager'));
  FlowStorage = (await import('~/flow/storage')).FlowStateStorage;
  csrf = await import('~/oauth/csrf');
  handlers = await import('../mcp');
  mongo = await MongoMemoryServer.create({ binary: { version: '8.2.1' } });
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  process.env = {
    ...environment,
    ...credentials,
    GOVERNANCE_PILOT_ENABLED: 'true',
    GOVERNANCE_MCP_AUDIT_URL: 'https://gateway.example/internal/mcp-audit',
    LIBRECHAT_SERVICE_CREDENTIAL: 'audit-service-credential',
    JWT_SECRET: 'test-oauth-secret',
    DOMAIN_CLIENT: 'https://chat.example/chat',
  };
  await schemas.runAsSystem(async () => {
    await models.User.deleteMany({});
    await models.MCPServer.deleteMany({});
    await outbox().deleteMany({});
  });
  await schemas.tenantStorage.run({ tenantId }, async () => {
    actor = await models.User.create({
      email: 'admin@example.test',
      provider: 'openid',
      role: 'GOVERNANCE_ADMIN',
      openidIssuer: 'https://identity.example',
      openidId: 'administrator-subject',
    });
    const connection = await models.MCPServer.create({
      serverName,
      author: actor._id,
      config: { type: 'sse', url: 'https://remote.example/mcp', requiresOAuth: true },
    });
    connectionId = connection._id.toString();
  });
  store = new Keyv();
  manager = new FlowManager<MCPOAuthTokens | null>(store, { ttl: 600000, ci: true });
  flowId = OAuth.generateFlowId(actor.id, serverName, tenantId);
  await manager.initFlow(flowId, 'mcp_oauth', {
    state,
    serverName,
    userId: actor.id,
    tenantId,
    serverUrl: 'https://remote.example/mcp',
    codeVerifier: 'confidential-verifier',
    clientInfo: { client_id: 'client', client_secret: 'confidential-client-secret' },
  });
  await OAuth.storeStateMapping(state, flowId, manager);
});
afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

function app(requestTenant?: string) {
  const contexts: (string | undefined)[] = [];
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.cookies = {
      oauth_csrf:
        req.get('x-test-csrf') ?? req.headers.cookie?.match(/(?:^|;\s*)oauth_csrf=([^;]+)/)?.[1],
      oauth_session:
        req.get('x-test-session') ??
        req.headers.cookie?.match(/(?:^|;\s*)oauth_session=([^;]+)/)?.[1],
    };
    Object.assign(req, { user: { id: 'browser-supplied-actor', role: 'USER' } });
    if (requestTenant) schemas.tenantStorage.run({ tenantId: requestTenant }, next);
    else next();
  });
  const handler = handlers.createGovernanceMCPOAuthFailureHandler({
    getFlowManager: () => manager,
    findUser: async (...args) => {
      contexts.push(schemas.getTenantId());
      return methods.findUser(...args);
    },
    getServerConfig: async (name) => {
      contexts.push(schemas.getTenantId());
      const connection = await methods.findMCPServerByServerName(name);
      return connection ? { ...connection.config, dbId: connection._id.toString() } : undefined;
    },
  });
  server.get('/callback/:serverName', handler);
  server.get('/:serverName/oauth/callback', handler);
  server.patch('/rejected', (req, res) => {
    Object.assign(req, { user: actor });
    return handlers.rejectGovernanceMCPUpdate(
      req as ServerRequest,
      res,
      { message: 'Invalid configuration' },
      connectionId,
    );
  });
  return { server, contexts };
}

it('audits a denied authorization using browser cookies under the public chat base path', async () => {
  process.env.SESSION_COOKIE_SECURE = 'false';
  const { server: callbacks, contexts } = app();
  const server = express();
  server.get('/chat/api/mcp/bind', (_req, res) => {
    csrf.setOAuthCsrfCookie(res, flowId, '/api/mcp');
    csrf.setOAuthSessionCookie(res, actor.id);
    res.sendStatus(204);
  });
  server.use('/chat/api/mcp', callbacks);
  const browser = request.agent(server);
  await browser.get('/chat/api/mcp/bind').expect(204);

  const response = await browser
    .get(`/chat/api/mcp/${serverName}/oauth/callback`)
    .query({ state, error: 'access_denied' });

  expect(response.headers.location).toBe('/chat/oauth/error?error=authorization_failed');
  expect((await outbox().findOne())?.payload).toMatchObject({
    action: 'mcp.oauth.authorized',
    outcome: 'failure',
    actor: { issuer: actor.openidIssuer, user_id: actor.openidId },
    resource: { type: 'mcp_connection', id: connectionId },
  });
  expect(contexts).toEqual([tenantId, tenantId]);
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({
    status: 'FAILED',
    error: 'authorization_failed',
  });
  expect(await models.Token.countDocuments({})).toBe(0);
});

it.each(['csrf', 'session'])(
  'audits the real flow actor and restores its tenant using the %s browser binding',
  async (binding) => {
    const { server, contexts } = app();
    const response = await request(server)
      .get(`/callback/${serverName}`)
      .query({ state, error: 'access_denied', error_description: 'confidential-provider-detail' })
      .set(
        binding === 'csrf' ? 'x-test-csrf' : 'x-test-session',
        csrf.generateOAuthCsrfToken(binding === 'csrf' ? flowId : actor.id),
      );
    expect(response.headers.location).toBe('/chat/oauth/error?error=authorization_failed');
    const event = await outbox().findOne();
    expect(event?.payload).toMatchObject({
      action: 'mcp.oauth.authorized',
      outcome: 'failure',
      actor: { issuer: actor.openidIssuer, user_id: actor.openidId },
      resource: { type: 'mcp_connection', id: connectionId },
    });
    expect(contexts).toEqual([tenantId, tenantId]);
    expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({
      status: 'FAILED',
      error: 'authorization_failed',
    });
    expect(JSON.stringify(event)).not.toMatch(/confidential|access_denied|browser-supplied-actor/);
    expect(await models.Token.countDocuments({})).toBe(0);
  },
);

it.each([
  'unknown-state',
  'wrong-state',
  'wrong-user',
  'wrong-server',
  'wrong-tenant',
  'expired',
  'completed',
  'no-cookie',
  'wrong-cookie',
  'wrong-path',
  'request-tenant',
])('does not audit or change an untrusted OAuth error callback: %s', async (invalid) => {
  const flow = (await manager.getFlowState(flowId, 'mcp_oauth'))!;
  if (invalid === 'wrong-state') flow.metadata.state = 'different-state';
  if (invalid === 'wrong-user') flow.metadata.userId = new mongoose.Types.ObjectId().toString();
  if (invalid === 'wrong-server') flow.metadata.serverName = 'different-server';
  if (invalid === 'wrong-tenant') flow.metadata.tenantId = 'different-tenant';
  if (invalid === 'expired') flow.createdAt = Date.now() - staleMs;
  if (invalid === 'completed') flow.status = 'COMPLETED';
  await new FlowStorage<MCPOAuthTokens | null>(store, 600000).set(`mcp_oauth:${flowId}`, flow);
  const { server } = app(invalid === 'request-tenant' ? 'another-tenant' : undefined);
  const callback = request(server)
    .get(`/callback/${invalid === 'wrong-path' ? 'different-server' : serverName}`)
    .query({ state: invalid === 'unknown-state' ? 'forged-state' : state, error: 'access_denied' });
  if (invalid !== 'no-cookie')
    callback.set(
      'x-test-csrf',
      invalid === 'wrong-cookie'
        ? csrf.generateOAuthCsrfToken('another-flow')
        : csrf.generateOAuthCsrfToken(flowId),
    );
  const response = await callback;
  expect(response.headers.location).toBe('/chat/oauth/error?error=authorization_failed');
  expect(await outbox().countDocuments()).toBe(0);
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({ status: flow.status });
});

it('does not audit a callback after the administrator entitlement is removed', async () => {
  await schemas.tenantStorage.run({ tenantId }, () =>
    models.User.updateOne({ _id: actor._id }, { role: 'USER' }),
  );
  const { server } = app();
  await request(server)
    .get(`/callback/${serverName}`)
    .query({ state, error: 'access_denied' })
    .set('x-test-csrf', csrf.generateOAuthCsrfToken(flowId));
  expect(await outbox().countDocuments()).toBe(0);
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({ status: 'PENDING' });
});

it('keeps an audit-storage outage a failed callback without exchanging or storing tokens', async () => {
  const { server } = app();
  const database = mongoose.connection.db!;
  const collection = database.collection.bind(database);
  jest.spyOn(database, 'collection').mockImplementation((name, options) => {
    if (name === 'governance_group_audit_outbox')
      throw new Error('confidential-audit-storage-detail');
    return collection(name, options);
  });
  const response = await request(server)
    .get(`/callback/${serverName}`)
    .query({ state, error: 'access_denied' })
    .set('x-test-csrf', csrf.generateOAuthCsrfToken(flowId));
  expect(response.headers.location).toBe('/chat/oauth/error?error=callback_failed');
  expect(JSON.stringify(response.headers)).not.toContain('confidential');
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({ status: 'PENDING' });
  expect(await models.Token.countDocuments({})).toBe(0);
});

it('audits a rejected update using only the known connection reference', async () => {
  const { server } = app();
  expect((await request(server).patch('/rejected')).status).toBe(400);
  const event = await outbox().findOne();
  expect(event?.payload).toMatchObject({
    action: 'mcp.updated',
    outcome: 'failure',
    resource: { type: 'mcp_connection', id: connectionId },
  });
});
