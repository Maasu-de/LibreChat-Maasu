import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { IUser } from '@librechat/data-schemas';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';

let mockRegistry: MCPServersRegistry;

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('~/governance/audit'),
  ...jest.requireActual('~/governance/mcp'),
  ...jest.requireActual('~/governance/mode'),
  ...jest.requireActual('~/mcp/utils'),
  ...jest.requireActual('~/mcp/errors'),
  checkAccess: jest.fn().mockResolvedValue(false),
}));
jest.mock(
  '~/server/services/MCP',
  () => ({ resolveMcpConfigNames: jest.fn().mockResolvedValue([]) }),
  { virtual: true },
);
jest.mock('~/server/services/Config', () => ({}), { virtual: true });
jest.mock('~/server/services/PermissionService', () => ({}), { virtual: true });
jest.mock('~/server/middleware/roles/capabilities', () => ({}), { virtual: true });
jest.mock('~/config', () => ({ getMCPServersRegistry: () => mockRegistry }), { virtual: true });
jest.mock('~/models', () => ({}), { virtual: true });

const environment = process.env;
let replica: MongoMemoryReplSet;
let schemas: typeof import('@librechat/data-schemas');
let models: ReturnType<typeof import('@librechat/data-schemas').createModels>;
let actor: IUser;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, { user: actor });
  void schemas.runAsSystem(async () => next());
});
const outbox = () => mongoose.connection.db!.collection('governance_group_audit_outbox');
const config = {
  type: 'sse',
  url: 'https://mcp.example/server',
  title: 'Managed remote',
  apiKey: { source: 'admin', authorization_type: 'bearer', key: 'confidential-service-key' },
};

beforeAll(async () => {
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';
  schemas = await import('@librechat/data-schemas');
  models = schemas.createModels(mongoose);
  replica = await MongoMemoryReplSet.create({
    binary: { version: '8.2.1' },
    replSet: { count: 1 },
  });
  await mongoose.connect(replica.getUri());
  await models.MCPServer.init();
  await models.AclEntry.init();
  await schemas.createMethods(mongoose).seedDefaultRoles();
  await mongoose.connection.db!.createCollection('governance_group_audit_outbox');
  const controllers = await import('../../../../../api/server/controllers/mcp');
  app.post('/servers', controllers.createMCPServerController);
  app.patch('/servers/:serverName', controllers.updateMCPServerController);
  app.delete('/servers/:serverName', controllers.deleteMCPServerController);
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});
beforeEach(async () => {
  process.env = {
    ...process.env,
    GOVERNANCE_PILOT_ENABLED: 'true',
    GOVERNANCE_MCP_AUDIT_URL: 'https://gateway.example/api/v1/internal/mcp-audit',
    LIBRECHAT_SERVICE_CREDENTIAL: 'audit-service-credential',
  };
  await schemas.runAsSystem(async () => {
    await models.MCPServer.deleteMany({});
    await models.AclEntry.deleteMany({});
    await models.User.deleteMany({});
    await outbox().deleteMany({});
    actor = await models.User.create({
      email: 'admin@example.test',
      provider: 'openid',
      role: 'GOVERNANCE_ADMIN',
      openidIssuer: 'https://identity.example',
      openidId: 'administrator-subject',
    });
  });
  const { MCPServerInspector } = await import('~/mcp/registry/MCPServerInspector');
  jest
    .spyOn(MCPServerInspector, 'inspect')
    .mockImplementation(async (_name, input) => ({ ...input }));
  const { MCPServersRegistry } = await import('~/mcp/registry/MCPServersRegistry');
  mockRegistry = new MCPServersRegistry(mongoose);
});
afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

async function create() {
  const response = await request(app).post('/servers').send({ config });
  expect(response.status).toBe(201);
  return response.body.serverName as string;
}
function failAudit(once = false) {
  const database = mongoose.connection.db!;
  const original = database.collection.bind(database);
  let failed = false;
  jest.spyOn(database, 'collection').mockImplementation((name, options) => {
    if (name === 'governance_group_audit_outbox' && (!once || !failed)) {
      failed = true;
      throw new Error('private outbox failure');
    }
    return original(name, options);
  });
}

it('commits create, update, and delete with matching success events and encrypted credentials', async () => {
  const name = await create();
  const created = await schemas.runAsSystem(() =>
    models.MCPServer.findOne({ serverName: name }).lean(),
  );
  expect(JSON.stringify(created)).not.toContain('confidential-service-key');
  const id = created!._id.toString();
  const update = await request(app)
    .patch(`/servers/${name}`)
    .send({
      config: {
        ...config,
        title: 'Updated remote',
        apiKey: { source: 'admin', authorization_type: 'bearer' },
      },
    });
  expect(update.status).toBe(200);
  expect(update.body.dbId).toBe(id);
  expect(update.body.title).toBe('Updated remote');
  expect(JSON.stringify(update.body)).not.toContain('confidential-service-key');
  expect((await request(app).delete(`/servers/${name}`)).status).toBe(200);
  expect(await schemas.runAsSystem(() => models.MCPServer.countDocuments())).toBe(0);
  expect(await schemas.runAsSystem(() => models.AclEntry.countDocuments())).toBe(0);
  const events = await outbox().find({}).sort({ createdAt: 1 }).toArray();
  expect(
    events.map(({ payload }) => [payload.action, payload.outcome, payload.resource.id]),
  ).toEqual([
    ['mcp.created', 'success', id],
    ['mcp.updated', 'success', id],
    ['mcp.deleted', 'success', id],
  ]);
  expect(JSON.stringify(events)).not.toContain('confidential-service-key');
});
it('rolls back both server and owner ACL when create audit storage fails', async () => {
  failAudit();
  const response = await request(app).post('/servers').send({ config }).timeout(10000);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.text).not.toContain('private outbox failure');
  expect(await schemas.runAsSystem(() => models.MCPServer.countDocuments())).toBe(0);
  expect(await schemas.runAsSystem(() => models.AclEntry.countDocuments())).toBe(0);
});
it('audits rejected creations with distinct attempt references and no submitted secrets', async () => {
  const responses = await Promise.all(
    [
      { type: 'stdio', command: 'confidential-command' },
      { ...config, url: 'https://mcp.example/server?key=confidential-url-key' },
    ].map((input) => request(app).post('/servers').send({ config: input })),
  );
  expect(responses.map(({ status }) => status)).toEqual([400, 400]);
  expect(await schemas.runAsSystem(() => models.MCPServer.countDocuments())).toBe(0);
  expect(await schemas.runAsSystem(() => models.AclEntry.countDocuments())).toBe(0);
  const events = await outbox().find({}).toArray();
  expect(events).toHaveLength(2);
  expect(new Set(events.map(({ payload }) => payload.resource.id)).size).toBe(2);
  for (const event of events) {
    expect(event.payload).toMatchObject({
      action: 'mcp.created',
      outcome: 'failure',
      actor: { issuer: actor.openidIssuer, user_id: actor.openidId },
      resource: { type: 'mcp_connection', id: expect.stringMatching(/^[a-f0-9]{24}$/) },
      occurred_at: expect.any(String),
    });
  }
  expect(JSON.stringify(events)).not.toMatch(/confidential|mcp\.example/);
});
it('audits an inspection failure with a safe creation-attempt reference', async () => {
  const { MCPServerInspector } = await import('~/mcp/registry/MCPServerInspector');
  jest
    .mocked(MCPServerInspector.inspect)
    .mockRejectedValueOnce(new Error('Unreachable server with confidential-service-key'));
  const response = await request(app).post('/servers').send({ config });
  expect(response.status).toBe(400);
  expect(await schemas.runAsSystem(() => models.MCPServer.countDocuments())).toBe(0);
  expect(await schemas.runAsSystem(() => models.AclEntry.countDocuments())).toBe(0);
  const events = await outbox().find({}).toArray();
  expect(events).toHaveLength(1);
  expect(events[0].payload).toMatchObject({
    action: 'mcp.created',
    outcome: 'failure',
    actor: { issuer: actor.openidIssuer, user_id: actor.openidId },
    resource: { type: 'mcp_connection', id: expect.stringMatching(/^[a-f0-9]{24}$/) },
  });
  expect(JSON.stringify(events)).not.toMatch(/confidential|mcp\.example/);
});
it('audits a rolled-back creation after a transient audit-storage failure', async () => {
  failAudit(true);
  const response = await request(app).post('/servers').send({ config });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await schemas.runAsSystem(() => models.MCPServer.countDocuments())).toBe(0);
  expect(await schemas.runAsSystem(() => models.AclEntry.countDocuments())).toBe(0);
  const events = await outbox().find({}).toArray();
  expect(events).toHaveLength(1);
  expect(events[0].payload).toMatchObject({
    action: 'mcp.created',
    outcome: 'failure',
    resource: { type: 'mcp_connection', id: expect.stringMatching(/^[a-f0-9]{24}$/) },
  });
  expect(JSON.stringify(events)).not.toContain('confidential-service-key');
});
it('does not audit rejected creation input outside governed mode', async () => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'false';
  const response = await request(app)
    .post('/servers')
    .send({ config: { type: 'stdio', command: 'confidential-command' } });
  expect(response.status).toBe(400);
  expect(await outbox().countDocuments()).toBe(0);
});
it('rolls back an update when enqueue fails and records the actual failed outcome', async () => {
  const name = await create();
  const previous = await schemas.runAsSystem(() =>
    models.MCPServer.findOne({ serverName: name }).lean(),
  );
  await outbox().deleteMany({});
  failAudit(true);
  const response = await request(app)
    .patch(`/servers/${name}`)
    .send({ config: { ...config, title: 'Must roll back' } });
  expect(response.status).toBeGreaterThanOrEqual(400);
  const current = await schemas.runAsSystem(() =>
    models.MCPServer.findOne({ serverName: name }).lean(),
  );
  expect(current!.config).toEqual(previous!.config);
  expect(current!.updatedAt).toEqual(previous!.updatedAt);
  expect((await outbox().findOne())?.payload).toMatchObject({
    action: 'mcp.updated',
    outcome: 'failure',
  });
});
it('restores server and ACL after delete audit failure and responds during a persistent outage', async () => {
  const name = await create();
  const previousACL = await schemas.runAsSystem(() => models.AclEntry.find({}).lean());
  failAudit();
  const response = await request(app).delete(`/servers/${name}`).timeout(10000);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(
    await schemas.runAsSystem(() => models.MCPServer.countDocuments({ serverName: name })),
  ).toBe(1);
  expect(await schemas.runAsSystem(() => models.AclEntry.find({}).lean())).toEqual(previousACL);
});
it('preserves unique names and audit events for concurrent creates with the same title', async () => {
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => request(app).post('/servers').send({ config })),
  );
  expect(responses.map(({ status }) => status)).toEqual([201, 201, 201]);
  expect(new Set(responses.map(({ body }) => body.serverName)).size).toBe(3);
  expect(await schemas.runAsSystem(() => models.MCPServer.countDocuments())).toBe(3);
  expect(await schemas.runAsSystem(() => models.AclEntry.countDocuments())).toBe(3);
  expect(
    await outbox().countDocuments({
      'payload.action': 'mcp.created',
      'payload.outcome': 'success',
    }),
  ).toBe(3);
});
