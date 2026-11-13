import { Keyv } from 'keyv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { IUser } from '@librechat/data-schemas';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import type { FlowStateManager } from '~/flow/manager';
import type { ServerRequest } from '~/types/http';

let replica: MongoMemoryReplSet;
let schemas: typeof import('@librechat/data-schemas');
let models: ReturnType<typeof schemas.createModels>;
let methods: ReturnType<typeof schemas.createMethods>;
let administration: typeof import('../mcp');
let authorization: typeof import('../oauth');
let storage: typeof import('~/mcp/oauth').MCPTokenStorage;
let Factory: typeof import('~/mcp/MCPConnectionFactory').MCPConnectionFactory;
let FlowManager: typeof import('~/flow/manager').FlowStateManager;
let OAuth: typeof import('~/mcp/oauth').MCPOAuthHandler;
let bindingFor: typeof import('../authorization').getGovernanceMCPOAuthBinding;
let actor: IUser;
const environment = { ...process.env };
const serverName = 'managed-remote';
const config = {
  dbId: '507f1f77bcf86cd799439011',
  type: 'streamable-http' as const,
  url: 'https://mcp.example/server',
  oauth: {},
  requiresOAuth: true,
};
let binding: string;
let flowManager: FlowStateManager<MCPOAuthTokens | null>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function tokens(accessToken = 'initial-access'): MCPOAuthTokens {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-secret',
    token_type: 'Bearer',
    obtained_at: Date.now(),
    expires_at: Date.now() + 3600000,
  };
}

beforeAll(async () => {
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';
  schemas = await import('@librechat/data-schemas');
  models = schemas.createModels(mongoose);
  methods = schemas.createMethods(mongoose);
  administration = await import('../mcp');
  authorization = await import('../oauth');
  storage = (await import('~/mcp/oauth')).MCPTokenStorage;
  Factory = (await import('~/mcp/MCPConnectionFactory')).MCPConnectionFactory;
  FlowManager = (await import('~/flow/manager')).FlowStateManager;
  OAuth = (await import('~/mcp/oauth')).MCPOAuthHandler;
  bindingFor = (await import('../authorization')).getGovernanceMCPOAuthBinding;
  replica = await MongoMemoryReplSet.create({
    binary: { version: '8.2.1' },
    replSet: { count: 1 },
  });
  await mongoose.connect(replica.getUri());
  await models.Token.createCollection();
  await mongoose.connection.db!.createCollection('governance_group_audit_outbox');
}, 60000);

beforeEach(async () => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
  process.env.GOVERNANCE_MCP_AUDIT_URL = 'https://governance.example/internal/mcp-audit';
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'service';
  binding = bindingFor(config)!;
  flowManager = new FlowManager(new Keyv(), { ttl: 60000, ci: true });
  await schemas.runAsSystem(async () => {
    await models.Token.deleteMany({});
    await models.User.deleteMany({});
    await mongoose.connection.db!.collection('governance_mcp_oauth_authorizations').deleteMany({});
    actor = await models.User.create({
      email: 'admin@test.example',
      provider: 'openid',
      role: 'GOVERNANCE_ADMIN',
      openidId: 'administrator',
      openidIssuer: 'https://identity.example',
    });
  });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  process.env = environment;
  await mongoose.disconnect();
  await replica.stop();
});

async function authorize(accessToken?: string) {
  await administration.storeGovernanceMCPOAuth(
    { user: actor } as ServerRequest,
    config.dbId,
    {
      userId: actor.id,
      serverName,
      binding,
      tokens: tokens(accessToken),
      clientInfo: { client_id: 'client', client_secret: 'client-secret' },
      createToken: methods.createToken,
      updateToken: methods.updateToken,
      findToken: methods.findToken,
    },
    await authorization.getGovernanceMCPOAuthGeneration(actor.id, config.dbId),
  );
}

function factory(refresh: () => Promise<MCPOAuthTokens>) {
  return new (class extends Factory {
    constructor() {
      super(
        { serverName, serverConfig: config },
        { user: actor, useOAuth: true, flowManager, tokenMethods: methods },
      );
    }

    protected createRefreshTokensFunction() {
      return refresh;
    }

    load() {
      return this.getOAuthTokens();
    }

    silent() {
      return this.attemptSilentTokenRefresh();
    }
  })();
}

async function revoke() {
  const handlers = administration.createGovernanceMCPHandlers({
    getRegistry: () => ({ getServerConfig: async () => config }),
    getManager: () => ({ disconnectUserConnection: async () => {} }),
    discover: async () => ({ tools: [], oauthRequired: false, oauthUrl: null }),
    revoke: async (userId, _plugin, _config, commit) => {
      if (!commit) throw new Error('Expected transactional revocation');
      await commit(async (session) => {
        // Match clearStoredMCPOAuthState's bound and legacy flow cleanup.
        const flows = [
          [OAuth.generateTokenFlowId(userId, serverName, undefined, binding), 'mcp_get_tokens'],
          [OAuth.generateFlowId(userId, serverName, undefined, binding), 'mcp_oauth'],
          [OAuth.generateFlowId(userId, serverName), 'mcp_get_tokens'],
          [OAuth.generateFlowId(userId, serverName), 'mcp_oauth'],
        ];
        for (const [id, type] of flows) {
          await flowManager.deleteFlow(id, type);
        }
        await storage.deleteUserTokens({
          userId,
          serverName,
          binding,
          deleteToken: async (filter) => {
            await methods.deleteTokens(filter, session);
          },
        });
      });
    },
  });
  const app = express();
  app.use((req, _res, next) => {
    (req as ServerRequest).user = actor;
    next();
  });
  app.post('/:serverName/revoke', handlers.revoke);
  const response = await request(app).post(`/${serverName}/revoke`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true });
}

it.each(['load', 'silent'] as const)(
  'refreshes an authorized connection through %s and stores encrypted credentials without advancing its generation',
  async (operation) => {
    await schemas.runAsSystem(async () => {
      await authorize();
      const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, config.dbId);
      await models.Token.deleteOne({
        userId: actor.id,
        identifier: `mcp:${serverName}:${binding}`,
      });
      const refreshed = tokens('refreshed-access');
      expect(await factory(async () => refreshed)[operation]()).toEqual(refreshed);
      expect(await authorization.getGovernanceMCPOAuthGeneration(actor.id, config.dbId)).toBe(
        generation,
      );
      expect(JSON.stringify(await models.Token.find().lean())).not.toContain('refreshed-access');
      expect(
        await storage.getTokens({
          userId: actor.id,
          serverName,
          binding,
          findToken: methods.findToken,
        }),
      ).toMatchObject({ access_token: 'refreshed-access' });
    });
  },
);

it.each([
  ['load', false],
  ['silent', false],
  ['load', true],
  ['silent', true],
] as const)(
  'rejects %s refresh completing after revocation and flow cleanup; reauthorized: %s',
  async (operation, reauthorize) => {
    await schemas.runAsSystem(async () => {
      await authorize();
      await models.Token.deleteOne({
        userId: actor.id,
        identifier: `mcp:${serverName}:${binding}`,
      });
      const started = deferred<void>();
      const remote = deferred<MCPOAuthTokens>();
      const pending = factory(async () => {
        started.resolve();
        return remote.promise;
      })[operation]();
      await started.promise;
      await revoke();
      expect(await models.Token.countDocuments()).toBe(0);
      if (reauthorize) await authorize('new-authorization-access');
      remote.resolve(tokens('stale-refreshed-access'));
      expect(await pending).toBeNull();
      expect(await models.Token.countDocuments()).toBe(reauthorize ? 3 : 0);
      expect(
        await authorization.isGovernanceMCPOAuthAuthorized(actor.id, config.dbId, binding),
      ).toBe(reauthorize);
      if (reauthorize)
        expect((await factory(async () => tokens()).load())?.access_token).toBe(
          'new-authorization-access',
        );
    });
  },
);

it('rejects cached credentials after revocation and never reuses them for a new authorization', async () => {
  await schemas.runAsSystem(async () => {
    await authorize();
    const refresh = jest.fn(async () => tokens('unexpected-refresh'));
    const connection = factory(refresh);
    expect((await connection.load())?.access_token).toBe('initial-access');
    await revoke();
    expect(await connection.load()).toBeNull();
    await authorize('new-authorization-access');
    expect((await connection.load())?.access_token).toBe('new-authorization-access');
    expect(refresh).not.toHaveBeenCalled();
  });
});

it('rejects a cached result when revocation commits while it is being read', async () => {
  await schemas.runAsSystem(async () => {
    await authorize();
    const connection = factory(async () => tokens('unexpected-refresh'));
    await connection.load();
    const read = deferred<void>();
    const release = deferred<void>();
    const original = flowManager.createFlowWithHandler.bind(flowManager);
    jest.spyOn(flowManager, 'createFlowWithHandler').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      read.resolve();
      await release.promise;
      return result;
    });
    const pending = connection.load();
    await read.promise;
    await revoke();
    release.resolve();
    expect(await pending).toBeNull();
  });
});

it('does not let a stale invalid_client response delete a new authorization', async () => {
  await schemas.runAsSystem(async () => {
    await authorize();
    const started = deferred<void>();
    const remote = deferred<MCPOAuthTokens>();
    const pending = factory(async () => {
      started.resolve();
      return remote.promise;
    }).silent();
    await started.promise;
    await revoke();
    await authorize('new-authorization-access');
    remote.reject(new Error('invalid_client'));
    expect(await pending).toBeNull();
    expect(await models.Token.countDocuments()).toBe(3);
    expect((await factory(async () => tokens()).load())?.access_token).toBe(
      'new-authorization-access',
    );
  });
});
