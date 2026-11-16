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

it.each(['no authentication', 'API key'] as const)(
  'keeps %s after switching from OAuth and saving another edit',
  async (authentication) => {
    const created = await request(app)
      .post('/servers')
      .send({
        config: {
          type: 'sse',
          url: config.url,
          title: config.title,
          oauth: {
            client_id: 'managed-client',
            client_secret: 'previous-oauth-secret',
            authorization_url: 'https://identity.example/authorize',
            token_url: 'https://identity.example/token',
          },
        },
      });
    expect(created.status).toBe(201);
    const serverName = created.body.serverName as string;
    const apiKey =
      authentication === 'API key'
        ? { source: 'admin', authorization_type: 'bearer', key: 'replacement-service-key' }
        : undefined;
    const switched = await request(app)
      .patch(`/servers/${serverName}`)
      .send({
        config: {
          type: 'sse',
          url: config.url,
          title: config.title,
          ...(apiKey && { apiKey }),
        },
      });
    expect(switched.status).toBe(200);
    expect(switched.body.oauth).toBeUndefined();
    expect(switched.body.apiKey).toEqual(
      apiKey ? { source: 'admin', authorization_type: 'bearer' } : undefined,
    );

    const renamed = await request(app)
      .patch(`/servers/${serverName}`)
      .send({
        config: {
          type: switched.body.type,
          url: switched.body.url,
          title: 'Renamed connection',
          ...(switched.body.apiKey && { apiKey: switched.body.apiKey }),
        },
      });
    expect(renamed.status).toBe(200);
    expect(renamed.body.oauth).toBeUndefined();
    const saved = await schemas.runAsSystem(() => models.MCPServer.findOne({ serverName }).lean());
    expect(saved!.config.oauth).toBeUndefined();
    if (apiKey) {
      expect(await schemas.decryptV2(saved!.config.apiKey!.key!)).toBe(apiKey.key);
    } else {
      expect(saved!.config.apiKey).toBeUndefined();
    }
  },
);

it('preserves an omitted client secret when OAuth discovery remains selected', async () => {
  const created = await request(app)
    .post('/servers')
    .send({
      config: {
        type: 'sse',
        url: config.url,
        title: config.title,
        oauth: {
          client_id: 'managed-client',
          client_secret: 'existing-oauth-secret',
          authorization_url: 'https://identity.example/authorize',
          token_url: 'https://identity.example/token',
        },
      },
    });
  expect(created.status).toBe(201);
  const serverName = created.body.serverName as string;
  const updated = await request(app)
    .patch(`/servers/${serverName}`)
    .send({ config: { type: 'sse', url: config.url, title: config.title, oauth: {} } });
  expect(updated.status).toBe(200);
  expect(updated.body.oauth).toEqual({});
  const saved = await schemas.runAsSystem(() => models.MCPServer.findOne({ serverName }).lean());
  expect(await schemas.decryptV2(saved!.config.oauth!.client_secret!)).toBe(
    'existing-oauth-secret',
  );
});

describe.each(['API key', 'OAuth client secret'] as const)('%s preservation', (credential) => {
  function connectionConfig(secret?: string) {
    return {
      type: 'sse' as const,
      url: config.url,
      title: config.title,
      ...(credential === 'API key'
        ? {
            apiKey: {
              source: 'admin' as const,
              authorization_type: 'bearer' as const,
              ...(secret ? { key: secret } : {}),
            },
          }
        : {
            oauth: {
              client_id: 'managed-client',
              authorization_url: 'https://identity.example/authorize',
              token_url: 'https://identity.example/token',
              ...(secret ? { client_secret: secret } : {}),
            },
          }),
    };
  }

  it.each([false, true])(
    'retains a second administrator rotation with a cached configuration; rotation during inspection: %s',
    async (duringInspection) => {
      const firstAdministrator = actor;
      const originalSecret = 'original-connection-secret';
      const rotatedSecret = 'rotated-connection-secret';
      const created = await request(app)
        .post('/servers')
        .send({ config: connectionConfig(originalSecret) });
      expect(created.status).toBe(201);
      const serverName = created.body.serverName as string;
      await schemas.runAsSystem(() =>
        mockRegistry.getServerConfig(serverName, firstAdministrator.id),
      );
      const secondAdministrator = await schemas.runAsSystem(() =>
        models.User.create({
          email: 'second-admin@example.test',
          provider: 'openid',
          role: 'GOVERNANCE_ADMIN',
          openidIssuer: 'https://identity.example',
          openidId: 'second-administrator-subject',
        }),
      );
      const rotate = async () => {
        actor = secondAdministrator;
        try {
          const response = await request(app)
            .patch(`/servers/${serverName}`)
            .send({ config: connectionConfig(rotatedSecret) });
          expect(response.status).toBe(200);
        } finally {
          actor = firstAdministrator;
        }
      };
      if (!duringInspection) await rotate();
      const { MCPServerInspector } = await import('~/mcp/registry/MCPServerInspector');
      let inspectedSecret: string | undefined;
      jest.mocked(MCPServerInspector.inspect).mockImplementationOnce(async (_name, input) => {
        inspectedSecret = input.apiKey?.key ?? input.oauth?.client_secret;
        if (duringInspection) await rotate();
        return { ...input };
      });
      const response = await request(app)
        .patch(`/servers/${serverName}`)
        .send({ config: { ...connectionConfig(), title: 'Updated connection title' } });
      expect(response.status).toBe(200);
      expect(response.body.title).toBe('Updated connection title');
      expect(inspectedSecret).toBe(duringInspection ? originalSecret : rotatedSecret);
      const saved = await schemas.runAsSystem(() =>
        models.MCPServer.findOne({ serverName }).lean(),
      );
      const encryptedSecret = saved!.config.apiKey?.key ?? saved!.config.oauth?.client_secret;
      expect(await schemas.decryptV2(encryptedSecret!)).toBe(rotatedSecret);
      for (const secret of [originalSecret, rotatedSecret]) {
        expect(JSON.stringify(saved)).not.toContain(secret);
        expect(JSON.stringify(response.body)).not.toContain(secret);
        expect(JSON.stringify(await outbox().find({}).toArray())).not.toContain(secret);
      }
    },
  );
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
