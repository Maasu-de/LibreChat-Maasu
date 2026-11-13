import http from 'node:http';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { Keyv } from 'keyv';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IUser } from '@librechat/data-schemas';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import type { ServerRequest } from '~/types/http';
import type { MCPConnection } from '~/mcp/connection';
import { trackSockets } from '~/mcp/__tests__/helpers/oauthTestServer';

let replica: MongoMemoryReplSet;
let schemas: typeof import('@librechat/data-schemas');
let models: ReturnType<typeof schemas.createModels>;
let methods: ReturnType<typeof schemas.createMethods>;
let administration: typeof import('../mcp');
let authorization: typeof import('../oauth');
let binding: typeof import('../authorization').getGovernanceMCPOAuthBinding;
let MCPManager: typeof import('~/mcp/MCPManager').MCPManager;
let ConnectionsRepository: typeof import('~/mcp/ConnectionsRepository').ConnectionsRepository;
let MCPServersRegistry: typeof import('~/mcp/registry/MCPServersRegistry').MCPServersRegistry;
let ServerConfigsDB: typeof import('~/mcp/registry/db/ServerConfigsDB').ServerConfigsDB;
let FlowStateManager: typeof import('~/flow/manager').FlowStateManager;
let MCPTokenStorage: typeof import('~/mcp/oauth').MCPTokenStorage;
let MCPConnectionFactory: typeof import('~/mcp/MCPConnectionFactory').MCPConnectionFactory;
const environment = process.env;
const initialToken = 'administrator-initial-access';
const freshToken = 'administrator-fresh-access';

beforeAll(async () => {
  process.env = {
    ...environment,
    GOVERNANCE_PILOT_ENABLED: 'true',
    GOVERNANCE_MCP_AUDIT_URL: 'https://governance.example/internal/mcp-audit',
    LIBRECHAT_SERVICE_CREDENTIAL: 'service',
    CREDS_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    CREDS_IV: '0123456789abcdef0123456789abcdef',
  };
  schemas = await import('@librechat/data-schemas');
  models = schemas.createModels(mongoose);
  methods = schemas.createMethods(mongoose);
  administration = await import('../mcp');
  authorization = await import('../oauth');
  binding = (await import('../authorization')).getGovernanceMCPOAuthBinding;
  MCPManager = (await import('~/mcp/MCPManager')).MCPManager;
  ConnectionsRepository = (await import('~/mcp/ConnectionsRepository')).ConnectionsRepository;
  MCPServersRegistry = (await import('~/mcp/registry/MCPServersRegistry')).MCPServersRegistry;
  ServerConfigsDB = (await import('~/mcp/registry/db/ServerConfigsDB')).ServerConfigsDB;
  FlowStateManager = (await import('~/flow/manager')).FlowStateManager;
  MCPTokenStorage = (await import('~/mcp/oauth')).MCPTokenStorage;
  MCPConnectionFactory = (await import('~/mcp/MCPConnectionFactory')).MCPConnectionFactory;
  replica = await MongoMemoryReplSet.create({
    binary: { version: '8.2.1' },
    replSet: { count: 1 },
  });
  await mongoose.connect(replica.getUri());
  await models.Token.createCollection();
  await mongoose.connection.db!.createCollection('governance_group_audit_outbox');
  await methods.seedDefaultRoles();
}, 60000);

beforeEach(async () => {
  jest.restoreAllMocks();
  await models.Token.deleteMany({});
  await models.MCPServer.deleteMany({});
  await models.User.deleteMany({});
});

afterAll(async () => {
  jest.restoreAllMocks();
  await mongoose.disconnect();
  await replica.stop();
  process.env = environment;
});

function createGate() {
  let signalStarted: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, released, release, signalStarted };
}

async function createFixture(pauseHandshake = false) {
  const initialGate = createGate();
  let handshake = pauseHandshake ? initialGate : undefined;
  const gates = [initialGate];
  const requests: (string | undefined)[] = [];
  const transports = new Set<StreamableHTTPServerTransport>();
  const remote = http.createServer(async (req, res) => {
    requests.push(req.headers.authorization);
    if (
      ![initialToken, freshToken].some((token) => req.headers.authorization === `Bearer ${token}`)
    ) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
      res.end();
      return;
    }
    if (handshake && req.method === 'POST') {
      const gate = handshake;
      handshake = undefined;
      gate.signalStarted();
      await gate.released;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transports.add(transport);
    const sdk = new Server({ name: 'revocation-race', version: '1.0.0' }, { capabilities: {} });
    res.on('close', () => {
      transports.delete(transport);
      void sdk.close();
    });
    await sdk.connect(transport);
    await transport.handleRequest(req, res);
  });
  const closeServer = trackSockets(remote);
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  if (!address || typeof address === 'string') throw new Error('MCP fixture has no TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  const actor: IUser = await models.User.create({
    email: 'connection-race@test.example',
    provider: 'openid',
    role: 'GOVERNANCE_ADMIN',
    openidId: 'administrator',
    openidIssuer: 'https://identity.example',
  });
  const database = new ServerConfigsDB(mongoose);
  const created = await database.add(
    'race',
    {
      type: 'streamable-http',
      url: `${origin}/mcp`,
      title: `Race ${actor.id}`,
      requiresOAuth: true,
      oauth: {
        client_id: 'administrative-client',
        authorization_url: `${origin}/authorize`,
        token_url: `${origin}/token`,
      },
    },
    actor.id,
  );
  const connectionId = created.config.dbId!;
  const oauthBinding = binding(created.config);
  const registry = new MCPServersRegistry(mongoose, [origin]);
  jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue(registry);
  const authorize = async (token = initialToken) =>
    administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      {
        userId: actor.id,
        serverName: created.serverName,
        binding: oauthBinding,
        tokens: { access_token: token, token_type: 'Bearer' },
        createToken: methods.createToken,
        updateToken: methods.updateToken,
        findToken: methods.findToken,
      },
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    );
  await authorize();
  const manager = new MCPManager();
  manager.appConnections = new ConnectionsRepository();
  const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), {
    ttl: 30000,
    ci: true,
  });
  const controller = new AbortController();
  const oauthStart = jest.fn();
  const attempts: Promise<MCPConnection>[] = [];
  const start = () => {
    const pending = manager.getUserConnection({
      user: actor,
      serverName: created.serverName,
      serverConfig: created.config,
      flowManager,
      tokenMethods: methods,
      returnOnOAuth: true,
      oauthStart,
      signal: controller.signal,
    });
    attempts.push(pending);
    void pending.catch(() => {});
    return pending;
  };
  const revoke = async (connectionManager = manager) => {
    const handlers = administration.createGovernanceMCPHandlers({
      getRegistry: () => registry,
      getManager: () => connectionManager,
      discover: async () => ({ tools: [], oauthRequired: false, oauthUrl: null }),
      revoke: async (userId, _plugin, _config, commit) => {
        if (!commit) throw new Error('Revocation requires a transaction');
        await commit(async (session) =>
          MCPTokenStorage.deleteUserTokens({
            userId,
            serverName: created.serverName,
            binding: oauthBinding,
            deleteToken: async (query) => {
              await methods.deleteTokens(query, session);
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
    await request(app).post(`/${created.serverName}/revoke`).expect(200);
    expect(await models.Token.countDocuments()).toBe(0);
    expect(
      await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId, oauthBinding),
    ).toBe(false);
  };
  return {
    actor,
    serverName: created.serverName,
    manager,
    requests,
    started: initialGate.started,
    release: initialGate.release,
    pauseNextHandshake: () => {
      const gate = createGate();
      gates.push(gate);
      handshake = gate;
      return gate;
    },
    start,
    revoke,
    authorize,
    oauthStart,
    close: async () => {
      gates.forEach((gate) => gate.release());
      controller.abort();
      await Promise.allSettled(attempts);
      await manager.disconnectUserConnections(actor.id);
      await Promise.all([...transports].map((transport) => transport.close()));
      await closeServer();
    },
  };
}

it('does not cache a connection whose authenticated handshake finishes after revocation', async () => {
  const fixture = await createFixture(true);
  const pending = fixture.start();
  try {
    await fixture.started;
    await fixture.revoke();
    fixture.release();
    await expect(pending).rejects.toThrow('MCP OAuth authorization is no longer current');
    expect(
      fixture.manager.getUserConnections(fixture.actor.id)?.has(fixture.serverName) ?? false,
    ).toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);

it('reuses an authorized connection but discards it when another process revokes the grant', async () => {
  const fixture = await createFixture();
  try {
    const initial = await fixture.start();
    expect(await fixture.start()).toBe(initial);
    await fixture.revoke(new MCPManager());
    await expect(fixture.start()).rejects.toThrow('OAuth flow initiated - return early');
    await expect(initial.isConnected()).resolves.toBe(false);
    expect(
      fixture.manager.getUserConnections(fixture.actor.id)?.has(fixture.serverName) ?? false,
    ).toBe(false);
    expect(fixture.oauthStart).toHaveBeenCalledTimes(1);
  } finally {
    await fixture.close();
  }
}, 30000);

it('does not relabel an old connection after revocation and fresh authorization of the same target', async () => {
  const fixture = await createFixture();
  try {
    const initial = await fixture.start();
    await fixture.revoke(new MCPManager());
    await fixture.authorize(freshToken);
    await expect(MCPConnectionFactory.assertConnectionAuthorization(initial)).rejects.toThrow();
    fixture.requests.length = 0;
    const replacement = await fixture.start();
    expect(replacement).not.toBe(initial);
    await expect(initial.isConnected()).resolves.toBe(false);
    expect(fixture.requests).toContain(`Bearer ${freshToken}`);
    expect(fixture.requests).not.toContain(`Bearer ${initialToken}`);
    expect(await fixture.start()).toBe(replacement);
  } finally {
    await fixture.close();
  }
}, 30000);

it('discards a tentative cache entry when its publication transaction fails', async () => {
  const fixture = await createFixture();
  const publish = MCPConnectionFactory.publishConnectionAuthorization;
  const failure = new Error('Publication failed after inserting the cache entry');
  let unpublished: MCPConnection | undefined;
  jest
    .spyOn(MCPConnectionFactory, 'publishConnectionAuthorization')
    .mockImplementation((connection, operation) =>
      publish.call(MCPConnectionFactory, connection, () => {
        unpublished = connection;
        operation();
        throw failure;
      }),
    );
  try {
    await expect(fixture.start()).rejects.toBe(failure);
    if (!unpublished) throw new Error('MCP connection was not published');
    await expect(unpublished.isConnected()).resolves.toBe(false);
    expect(
      fixture.manager.getUserConnections(fixture.actor.id)?.has(fixture.serverName) ?? false,
    ).toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);

it('does not reconnect a disposed governed connection after a queued reconnect delay', async () => {
  const fixture = await createFixture();
  try {
    const connection = await fixture.start();
    const disconnect = jest.spyOn(connection, 'disconnect');
    jest.spyOn(Math, 'random').mockReturnValue(0);
    connection.emit('connectionChange', 'error');
    await fixture.manager.disconnectUserConnection(fixture.actor.id, fixture.serverName);
    const count = fixture.requests.length;
    const cleanupCalls = disconnect.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(fixture.requests).toHaveLength(count);
    expect(disconnect).toHaveBeenCalledTimes(cleanupCalls);
    await expect(connection.isConnected()).resolves.toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);

it('does not return a connection disconnected before cache publication resolves', async () => {
  const fixture = await createFixture();
  const publish = MCPConnectionFactory.publishConnectionAuthorization;
  jest
    .spyOn(MCPConnectionFactory, 'publishConnectionAuthorization')
    .mockImplementation(async (connection, operation) => {
      await publish.call(MCPConnectionFactory, connection, operation);
      await fixture.manager.disconnectUserConnection(fixture.actor.id, fixture.serverName);
    });
  try {
    await expect(fixture.start()).rejects.toThrow('MCP OAuth authorization is no longer current');
    expect(
      fixture.manager.getUserConnections(fixture.actor.id)?.has(fixture.serverName) ?? false,
    ).toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);

it('does not restore a connection disposed during an in-flight reconnect handshake', async () => {
  const fixture = await createFixture();
  try {
    const connection = await fixture.start();
    const gate = fixture.pauseNextHandshake();
    const reconnect = connection.connect();
    void reconnect.catch(() => {});
    await gate.started;
    await fixture.manager.disconnectUserConnection(fixture.actor.id, fixture.serverName);
    gate.release();
    await expect(reconnect).rejects.toThrow();
    await expect(connection.isConnected()).resolves.toBe(false);
    expect(
      fixture.manager.getUserConnections(fixture.actor.id)?.has(fixture.serverName) ?? false,
    ).toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);
