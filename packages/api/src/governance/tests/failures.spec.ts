import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { Keyv } from 'keyv';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  getTenantId,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import { MCPOAuthHandler } from '~/mcp/oauth';
import { FlowStateManager, PENDING_STALE_MS } from '~/flow/manager';
import { generateOAuthCsrfToken } from '~/oauth/csrf';
import { createGovernanceMCPOAuthFailureHandler, rejectGovernanceMCPUpdate } from '../mcp';

const environment = process.env;
const models = createModels(mongoose);
const methods = createMethods(mongoose);
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
    GOVERNANCE_PILOT_ENABLED: 'true',
    GOVERNANCE_MCP_AUDIT_URL: 'https://gateway.example/internal/mcp-audit',
    LIBRECHAT_SERVICE_CREDENTIAL: 'audit-service-credential',
    JWT_SECRET: 'test-oauth-secret',
    DOMAIN_CLIENT: 'https://chat.example/chat',
  };
  await runAsSystem(async () => {
    await models.User.deleteMany({});
    await models.MCPServer.deleteMany({});
    await outbox().deleteMany({});
  });
  await tenantStorage.run({ tenantId }, async () => {
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
  manager = new FlowStateManager<MCPOAuthTokens | null>(store, { ttl: 600000, ci: true });
  flowId = MCPOAuthHandler.generateFlowId(actor.id, serverName, tenantId);
  await manager.initFlow(flowId, 'mcp_oauth', {
    state,
    serverName,
    userId: actor.id,
    tenantId,
    serverUrl: 'https://remote.example/mcp',
    codeVerifier: 'confidential-verifier',
    clientInfo: { client_id: 'client', client_secret: 'confidential-client-secret' },
  });
  await MCPOAuthHandler.storeStateMapping(state, flowId, manager);
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
    req.cookies = { oauth_csrf: req.get('x-test-csrf'), oauth_session: req.get('x-test-session') };
    Object.assign(req, { user: { id: 'browser-supplied-actor', role: 'USER' } });
    if (requestTenant) tenantStorage.run({ tenantId: requestTenant }, next);
    else next();
  });
  const handler = createGovernanceMCPOAuthFailureHandler({
    getFlowManager: () => manager,
    findUser: async (...args) => {
      contexts.push(getTenantId());
      return methods.findUser(...args);
    },
    getServerConfig: async (name) => {
      contexts.push(getTenantId());
      const connection = await methods.findMCPServerByServerName(name);
      return connection ? { ...connection.config, dbId: connection._id.toString() } : undefined;
    },
  });
  server.get('/callback/:serverName', handler);
  server.patch('/rejected', (req, res) => {
    Object.assign(req, { user: actor });
    return rejectGovernanceMCPUpdate(
      req as ServerRequest,
      res,
      { message: 'Invalid configuration' },
      connectionId,
    );
  });
  return { server, contexts };
}

it.each(['csrf', 'session'])(
  'audits the real flow actor and restores its tenant using the %s browser binding',
  async (binding) => {
    const { server, contexts } = app();
    const response = await request(server)
      .get(`/callback/${serverName}`)
      .query({ state, error: 'access_denied', error_description: 'confidential-provider-detail' })
      .set(
        binding === 'csrf' ? 'x-test-csrf' : 'x-test-session',
        generateOAuthCsrfToken(binding === 'csrf' ? flowId : actor.id),
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
  if (invalid === 'expired') flow.createdAt = Date.now() - PENDING_STALE_MS;
  if (invalid === 'completed') flow.status = 'COMPLETED';
  await store.set(`mcp_oauth:${flowId}`, flow);
  const { server } = app(invalid === 'request-tenant' ? 'another-tenant' : undefined);
  const callback = request(server)
    .get(`/callback/${invalid === 'wrong-path' ? 'different-server' : serverName}`)
    .query({ state: invalid === 'unknown-state' ? 'forged-state' : state, error: 'access_denied' });
  if (invalid !== 'no-cookie')
    callback.set(
      'x-test-csrf',
      invalid === 'wrong-cookie'
        ? generateOAuthCsrfToken('another-flow')
        : generateOAuthCsrfToken(flowId),
    );
  const response = await callback;
  expect(response.headers.location).toBe('/chat/oauth/error?error=authorization_failed');
  expect(await outbox().countDocuments()).toBe(0);
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({ status: flow.status });
});

it('does not audit a callback after the administrator entitlement is removed', async () => {
  await tenantStorage.run({ tenantId }, () =>
    models.User.updateOne({ _id: actor._id }, { role: 'USER' }),
  );
  const { server } = app();
  await request(server)
    .get(`/callback/${serverName}`)
    .query({ state, error: 'access_denied' })
    .set('x-test-csrf', generateOAuthCsrfToken(flowId));
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
    .set('x-test-csrf', generateOAuthCsrfToken(flowId));
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
