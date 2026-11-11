import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';

let replica: MongoMemoryReplSet;
let schemas: typeof import('@librechat/data-schemas');
let models: ReturnType<typeof schemas.createModels>;
let methods: ReturnType<typeof schemas.createMethods>;
let administration: typeof import('../mcp');
let storage: typeof import('~/mcp/oauth').MCPTokenStorage;
let actor: IUser;
const environment = process.env;
const connectionId = '507f1f77bcf86cd799439011';
const serverName = 'administrative';
const outbox = () => mongoose.connection.db!.collection('governance_group_audit_outbox');
const failAuditWrites = () => {
  const database = mongoose.connection.db!;
  const original = database.collection.bind(database);
  return jest.spyOn(database, 'collection').mockImplementation((name, options) => {
    if (name === 'governance_group_audit_outbox') throw new Error('audit unavailable');
    return original(name, options);
  });
};
const tokenData = () => ({
  userId: actor.id,
  serverName,
  tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer' },
  clientInfo: { client_id: 'client', client_secret: 'client-secret' },
  createToken: methods.createToken,
  updateToken: methods.updateToken,
  findToken: methods.findToken,
});

beforeAll(async () => {
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';
  schemas = await import('@librechat/data-schemas');
  models = schemas.createModels(mongoose);
  methods = schemas.createMethods(mongoose);
  administration = await import('../mcp');
  storage = (await import('~/mcp/oauth')).MCPTokenStorage;
  replica = await MongoMemoryReplSet.create({
    binary: { version: '8.2.1' },
    replSet: { count: 1 },
  });
  await mongoose.connect(replica.getUri());
  await models.User.createCollection();
  await models.Token.createCollection();
  await mongoose.connection.db!.createCollection('governance_group_audit_outbox');
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});

beforeEach(async () => {
  process.env = {
    ...environment,
    GOVERNANCE_PILOT_ENABLED: 'true',
    GOVERNANCE_MCP_AUDIT_URL: 'https://governance.example/internal/mcp-audit',
    LIBRECHAT_SERVICE_CREDENTIAL: 'service',
  };
  await schemas.runAsSystem(async () => {
    await models.Token.deleteMany({});
    await models.User.deleteMany({});
    await outbox().deleteMany({});
    actor = await models.User.create({
      email: 'admin@test.example',
      provider: 'openid',
      role: 'GOVERNANCE_ADMIN',
      openidId: 'administrator',
      openidIssuer: 'https://identity.example',
    });
  });
});

afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

it('commits encrypted access, refresh, and client tokens with the authorization event', async () => {
  await schemas.runAsSystem(async () => {
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
    );
    expect(await models.Token.countDocuments()).toBe(3);
    expect((await outbox().findOne())?.payload).toMatchObject({
      action: 'mcp.oauth.authorized',
      outcome: 'success',
      resource: { id: connectionId },
    });
    const persisted = JSON.stringify(await models.Token.find().lean());
    for (const secret of ['access-secret', 'refresh-secret', 'client-secret']) {
      expect(persisted).not.toContain(secret);
      expect(JSON.stringify(await outbox().findOne())).not.toContain(secret);
    }
    expect(
      await storage.getTokens({ userId: actor.id, serverName, findToken: methods.findToken }),
    ).toMatchObject({ access_token: 'access-secret', refresh_token: 'refresh-secret' });
  });
});

it('rolls back token replacements when durable authorization audit insertion fails', async () => {
  await schemas.runAsSystem(async () => {
    await storage.storeTokens(tokenData());
    const before = await models.Token.find().sort({ identifier: 1 }).lean();
    const failure = failAuditWrites();
    const replacement = {
      ...tokenData(),
      tokens: {
        access_token: 'replacement',
        refresh_token: 'replacement-refresh',
        token_type: 'Bearer',
      },
    };
    await expect(
      administration.storeGovernanceMCPOAuth(
        { user: actor } as ServerRequest,
        connectionId,
        replacement,
      ),
    ).rejects.toThrow('audit unavailable');
    failure.mockRestore();
    expect(await models.Token.find().sort({ identifier: 1 }).lean()).toEqual(before);
    expect(await outbox().countDocuments()).toBe(0);
  });
});

it('rolls back earlier token writes when a later token write fails', async () => {
  await schemas.runAsSystem(async () => {
    await expect(
      administration.storeGovernanceMCPOAuth({ user: actor } as ServerRequest, connectionId, {
        ...tokenData(),
        createToken: (token, session) => {
          if (token.type === 'mcp_oauth_refresh') throw new Error('refresh persistence failed');
          return methods.createToken(token, session);
        },
      }),
    ).rejects.toThrow('refresh persistence failed');
    expect(await models.Token.countDocuments()).toBe(0);
    expect(await outbox().countDocuments()).toBe(0);
  });
});

it.each([false, true])(
  'revocation deletes tokens and audit together; outbox failure: %s',
  async (failAudit) => {
    await schemas.runAsSystem(async () => {
      await storage.storeTokens(tokenData());
      const before = await models.Token.find().sort({ identifier: 1 }).lean();
      const providerRevoke = jest.fn();
      const disconnect = jest.fn().mockResolvedValue(undefined);
      const handlers = administration.createGovernanceMCPHandlers({
        getRegistry: () => ({
          getServerConfig: jest.fn().mockResolvedValue({ dbId: connectionId }),
        }),
        getManager: () => ({ disconnectUserConnection: disconnect }),
        discover: jest.fn(),
        revoke: async (userId, _plugin, _config, commit) => {
          if (!commit) throw new Error('Governed deletion must supply a transaction');
          await commit(async (session) =>
            storage.deleteUserTokens({
              userId,
              serverName,
              deleteToken: async (filter) => {
                await methods.deleteTokens(filter, session);
              },
            }),
          );
          providerRevoke();
        },
      });
      const app = express();
      app.use((req, _res, next) => {
        (req as ServerRequest).user = actor;
        next();
      });
      app.post('/:serverName/revoke', handlers.revoke);
      const failure = failAudit ? failAuditWrites() : undefined;
      const response = await request(app).post(`/${serverName}/revoke`);
      failure?.mockRestore();
      expect(response.status).toBe(failAudit ? 500 : 200);
      expect(disconnect).toHaveBeenCalledWith(actor.id, serverName);
      if (failAudit) {
        expect(await models.Token.find().sort({ identifier: 1 }).lean()).toEqual(before);
        expect(await outbox().countDocuments()).toBe(0);
        expect(providerRevoke).not.toHaveBeenCalled();
      } else {
        expect(await models.Token.countDocuments()).toBe(0);
        expect((await outbox().findOne())?.payload).toMatchObject({
          action: 'mcp.oauth.revoked',
          outcome: 'success',
        });
        expect(providerRevoke).toHaveBeenCalledTimes(1);
      }
    });
  },
);
