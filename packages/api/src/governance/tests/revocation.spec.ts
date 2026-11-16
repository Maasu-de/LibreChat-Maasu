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
let authorization: typeof import('../oauth');
let storage: typeof import('~/mcp/oauth').MCPTokenStorage;
let actor: IUser;
const environment = process.env;
const connectionId = '507f1f77bcf86cd799439011';
const otherConnectionId = '507f1f77bcf86cd799439012';
const serverName = 'administrative';
const outbox = () => mongoose.connection.db!.collection('governance_group_audit_outbox');
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
  authorization = await import('../oauth');
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

async function revokeAuthorization() {
  const handlers = administration.createGovernanceMCPHandlers({
    getRegistry: () => ({
      getServerConfig: async () => ({
        type: 'sse',
        url: 'https://mcp.example/server',
        dbId: connectionId,
      }),
    }),
    getManager: () => ({ disconnectUserConnection: async () => {} }),
    discover: async () => ({ tools: [], oauthRequired: false, oauthUrl: null }),
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
    },
  });
  const app = express();
  app.use((req, _res, next) => {
    (req as ServerRequest).user = actor;
    next();
  });
  app.post('/:serverName/revoke', handlers.revoke);
  return request(app).post(`/${serverName}/revoke`);
}

function failAuditWrites() {
  const database = mongoose.connection.db!;
  const original = database.collection.bind(database);
  return jest.spyOn(database, 'collection').mockImplementation((name, options) => {
    if (name === 'governance_group_audit_outbox') throw new Error('audit unavailable');
    return original(name, options);
  });
}

it('rejects a callback whose token exchange finishes after successful revocation', async () => {
  await schemas.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const revoked = await revokeAuthorization();
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ success: true });
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(false);

    await expect(
      administration.storeGovernanceMCPOAuth(
        { user: actor } as ServerRequest,
        connectionId,
        tokenData(),
        generation,
      ),
    ).rejects.toThrow();

    expect(await models.Token.countDocuments()).toBe(0);
    const events = await outbox().find().toArray();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ action: 'mcp.oauth.revoked', outcome: 'success' });
  });
});

it('allows a fresh authorization started after revocation', async () => {
  await schemas.runAsSystem(async () => {
    const previous = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    expect((await revokeAuthorization()).status).toBe(200);
    const current = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    expect(current).toBeGreaterThan(previous);

    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      current,
    );

    expect(await models.Token.countDocuments()).toBe(3);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(true);
    expect(
      await storage.getTokens({ userId: actor.id, serverName, findToken: methods.findToken }),
    ).toMatchObject({ access_token: 'access-secret', refresh_token: 'refresh-secret' });
    const events = await outbox().find().sort({ createdAt: 1 }).toArray();
    expect(events.map(({ payload }) => payload.action)).toEqual([
      'mcp.oauth.revoked',
      'mcp.oauth.authorized',
    ]);
  });
});

it('reports authorization only for the connection configuration that received the grant', async () => {
  await schemas.runAsSystem(async () => {
    const binding = 'a'.repeat(64);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      { ...tokenData(), binding },
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    );
    expect(
      await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId, binding),
    ).toBe(true);
    expect(
      await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId, 'b'.repeat(64)),
    ).toBe(false);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(false);
  });
});

it('rejects an authorization transaction with a snapshot from before revocation committed', async () => {
  await schemas.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await models.Token.countDocuments().session(session);
      expect((await revokeAuthorization()).status).toBe(200);
      await expect(
        authorization.claimGovernanceMCPOAuthGeneration(
          actor.id,
          connectionId,
          generation,
          session,
        ),
      ).rejects.toThrow();
    } finally {
      await session.abortTransaction();
      await session.endSession();
    }
    expect(await models.Token.countDocuments()).toBe(0);
    expect(
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    ).toBeGreaterThan(generation);
  });
});

it('rolls back the revocation generation and token deletion when audit insertion fails', async () => {
  await schemas.runAsSystem(async () => {
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    );
    await outbox().deleteMany({});
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const tokens = await models.Token.find().sort({ identifier: 1 }).lean();
    const failure = failAuditWrites();
    const revoked = await revokeAuthorization();
    failure.mockRestore();

    expect(revoked.status).toBe(500);
    expect(await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId)).toBe(
      generation,
    );
    expect(await models.Token.find().sort({ identifier: 1 }).lean()).toEqual(tokens);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(true);
    expect(await outbox().countDocuments()).toBe(0);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    expect(await models.Token.countDocuments()).toBe(3);
  });
});

it('rolls back the authorization generation when storing its audit fails', async () => {
  await schemas.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const failure = failAuditWrites();
    await expect(
      administration.storeGovernanceMCPOAuth(
        { user: actor } as ServerRequest,
        connectionId,
        tokenData(),
        generation,
      ),
    ).rejects.toThrow('audit unavailable');
    failure.mockRestore();

    expect(await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId)).toBe(
      generation,
    );
    expect(await models.Token.countDocuments()).toBe(0);
    expect(await outbox().countDocuments()).toBe(0);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(false);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    expect(await models.Token.countDocuments()).toBe(3);
  });
});

it('isolates revocation generations by administrator, connection, and tenant', async () => {
  const otherUserId = new mongoose.Types.ObjectId().toString();
  const scopes = [
    { tenantId: 'first', userId: actor.id, connectionId },
    { tenantId: 'first', userId: otherUserId, connectionId },
    { tenantId: 'first', userId: actor.id, connectionId: otherConnectionId },
    { tenantId: 'second', userId: actor.id, connectionId },
  ];
  const generations = await Promise.all(
    scopes.map((scope) =>
      schemas.tenantStorage.run({ tenantId: scope.tenantId }, async () =>
        authorization.getGovernanceMCPOAuthGeneration(scope.userId, scope.connectionId),
      ),
    ),
  );
  const first = scopes[0];
  await schemas.tenantStorage.run({ tenantId: first.tenantId }, async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () =>
        authorization.claimGovernanceMCPOAuthGeneration(
          first.userId,
          first.connectionId,
          generations[0],
          session,
        ),
      );
    } finally {
      await session.endSession();
    }
  });
  const updated = await Promise.all(
    scopes.map((scope) =>
      schemas.tenantStorage.run({ tenantId: scope.tenantId }, async () =>
        authorization.getGovernanceMCPOAuthGeneration(scope.userId, scope.connectionId),
      ),
    ),
  );
  expect(updated[0]).toBeGreaterThan(generations[0]);
  expect(updated.slice(1)).toEqual(generations.slice(1));
});

it('does not publish or reconnect a committed grant after revocation wins the next transaction', async () => {
  await schemas.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    expect((await revokeAuthorization()).status).toBe(200);
    const publish = jest.fn(async () => {});

    await expect(
      authorization.withGovernanceMCPOAuthGeneration(
        actor.id,
        connectionId,
        generation + 1,
        publish,
      ),
    ).rejects.toThrow('MCP OAuth authorization is no longer current');

    expect(publish).not.toHaveBeenCalled();
    expect(await models.Token.countDocuments()).toBe(0);
  });
});

it('serializes revocation behind an authorization publication already in progress', async () => {
  await schemas.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    let releasePublication: () => void = () => {};
    let publicationStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishing = authorization.withGovernanceMCPOAuthGeneration(
      actor.id,
      connectionId,
      generation + 1,
      async () => {
        publicationStarted();
        await released;
      },
    );
    await started;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await expect(
        authorization.advanceGovernanceMCPOAuthGeneration(actor.id, connectionId, session),
      ).rejects.toThrow();
    } finally {
      await session.abortTransaction();
      await session.endSession();
      releasePublication();
      await publishing;
    }

    expect((await revokeAuthorization()).status).toBe(200);
    expect(await models.Token.countDocuments()).toBe(0);
    expect(await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId)).toBe(
      generation + 2,
    );
  });
});
