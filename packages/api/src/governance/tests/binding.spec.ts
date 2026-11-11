import http from 'node:http';
import mongoose from 'mongoose';
import { Keyv } from 'keyv';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPServerUserInputSchema } from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '~/mcp/types';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import { trackSockets } from '~/mcp/__tests__/helpers/oauthTestServer';

let mongo: MongoMemoryReplSet;
let schemas: typeof import('@librechat/data-schemas');
let models: ReturnType<typeof schemas.createModels>;
let methods: ReturnType<typeof schemas.createMethods>;
let bindingFor: typeof import('../authorization').getGovernanceMCPOAuthBinding;
let storeAuthorization: typeof import('../mcp').storeGovernanceMCPOAuth;
let getGeneration: typeof import('../oauth').getGovernanceMCPOAuthGeneration;
let Storage: typeof import('~/mcp/oauth').MCPTokenStorage;
let OAuth: typeof import('~/mcp/oauth').MCPOAuthHandler;
let Factory: typeof import('~/mcp/MCPConnectionFactory').MCPConnectionFactory;
let FlowManager: typeof import('~/flow/manager').FlowStateManager;
let Database: typeof import('~/mcp/registry/db/ServerConfigsDB').ServerConfigsDB;
let Registry: typeof import('~/mcp/registry/MCPServersRegistry').MCPServersRegistry;
let author: IUser;
let editor: IUser;
const environment = process.env;
const accessToken = 'administrator-authorization-for-original-connection';

async function createRemote() {
  const requests: { path: string; authorization?: string }[] = [];
  const transports = new Set<StreamableHTTPServerTransport>();
  let toolCalls = 0;
  const server = http.createServer(async (req, res) => {
    requests.push({ path: req.url ?? '/', authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${accessToken}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
      res.end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transports.add(transport);
    const sdk = new Server(
      { name: 'binding-regression', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }],
    }));
    sdk.setRequestHandler(CallToolRequestSchema, async () => {
      toolCalls++;
      return { content: [] };
    });
    res.on('close', () => {
      transports.delete(transport);
      void sdk.close();
    });
    await sdk.connect(transport);
    await transport.handleRequest(req, res);
  });
  const closeServer = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP fixture has no TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    getToolCalls: () => toolCalls,
    close: async () => {
      await Promise.all([...transports].map((transport) => transport.close()));
      await closeServer();
    },
  };
}

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
  bindingFor = (await import('../authorization')).getGovernanceMCPOAuthBinding;
  storeAuthorization = (await import('../mcp')).storeGovernanceMCPOAuth;
  getGeneration = (await import('../oauth')).getGovernanceMCPOAuthGeneration;
  ({ MCPTokenStorage: Storage, MCPOAuthHandler: OAuth } = await import('~/mcp/oauth'));
  Factory = (await import('~/mcp/MCPConnectionFactory')).MCPConnectionFactory;
  FlowManager = (await import('~/flow/manager')).FlowStateManager;
  Database = (await import('~/mcp/registry/db/ServerConfigsDB')).ServerConfigsDB;
  Registry = (await import('~/mcp/registry/MCPServersRegistry')).MCPServersRegistry;
  mongo = await MongoMemoryReplSet.create({
    binary: { version: '8.2.1' },
    replSet: { count: 1 },
  });
  await mongoose.connect(mongo.getUri());
  await models.Token.createCollection();
  await mongoose.connection.db!.createCollection('governance_group_audit_outbox');
  await methods.seedDefaultRoles();
}, 60000);

beforeEach(async () => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
  await models.Token.deleteMany({});
  await models.MCPServer.deleteMany({});
  await models.User.deleteMany({});
  [author, editor] = await models.User.create([
    {
      email: 'author@test.example',
      provider: 'openid',
      role: 'GOVERNANCE_ADMIN',
      openidId: 'author',
      openidIssuer: 'https://identity.example',
    },
    { email: 'editor@test.example', provider: 'openid', role: 'GOVERNANCE_ADMIN' },
  ]);
});

async function authorize(serverName: string, config: ParsedServerConfig) {
  await storeAuthorization(
    { user: author } as Parameters<typeof storeAuthorization>[0],
    config.dbId!,
    {
      userId: author.id,
      serverName,
      binding: bindingFor(config),
      tokens: { access_token: accessToken, token_type: 'Bearer' },
      createToken: methods.createToken,
    },
    await getGeneration(author.id, config.dbId!),
  );
}

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  process.env = environment;
});

async function inspect(
  serverName: string,
  serverConfig: ParsedServerConfig,
  manager: InstanceType<typeof FlowManager<MCPOAuthTokens | null>>,
) {
  const result = await Factory.discoverTools(
    { serverName, serverConfig, dbSourced: true, useSSRFProtection: false },
    { user: author, useOAuth: true, flowManager: manager, tokenMethods: methods },
    true,
  );
  await result.connection?.disconnect();
  return result;
}

it.each(['endpoint update', 'delete and recreate'])(
  'does not reuse another connection authorization after %s, including cached tokens',
  async (mutation) => {
    const remote = await createRemote();
    try {
      const database = new Database(mongoose);
      const registry = new Registry(mongoose, [remote.origin]);
      const manager = new FlowManager<MCPOAuthTokens | null>(new Keyv(), { ttl: 30000, ci: true });
      const created = await database.add(
        'original',
        {
          type: 'streamable-http',
          url: `${remote.origin}/original`,
          title: 'Managed',
          oauth: {},
          requiresOAuth: true,
          initTimeout: 2000,
        },
        author.id,
      );
      const binding = bindingFor(created.config);
      expect(binding).toBeDefined();
      await authorize(created.serverName, created.config);

      const initial = await inspect(created.serverName, created.config, manager);
      expect(initial.tools?.map((tool) => tool.name)).toEqual(['echo']);
      expect(remote.requests).toContainEqual({
        path: '/original',
        authorization: `Bearer ${accessToken}`,
      });
      const tokenFlowId = `${OAuth.generateTokenFlowId(
        author.id,
        created.serverName,
        undefined,
        binding,
      )}:generation:${await getGeneration(author.id, created.config.dbId!)}`;
      expect(await manager.getFlowState(tokenFlowId, 'mcp_get_tokens')).toMatchObject({
        status: 'COMPLETED',
        result: { access_token: accessToken },
      });

      const updated: MCPOptions = {
        type: 'streamable-http',
        url: `${remote.origin}/${mutation === 'endpoint update' ? 'changed' : 'original'}`,
        title: 'Managed',
        oauth: {},
      };
      MCPServerUserInputSchema.parse(updated);
      let current: ParsedServerConfig;
      if (mutation === 'endpoint update') {
        await registry.updateServer(created.serverName, updated, 'DB', editor.id, async (persist) =>
          persist(),
        );
        const persisted = await database.get(created.serverName, author.id);
        if (!persisted) throw new Error('Updated connection was not persisted');
        current = persisted;
      } else {
        await registry.removeServer(created.serverName, 'DB', editor.id, async (persist) =>
          persist(),
        );
        const replacement = await registry.addServer(
          'replacement',
          updated,
          'DB',
          editor.id,
          [],
          async (persist) => persist(),
        );
        expect(replacement.serverName).toBe(created.serverName);
        expect(replacement.config.dbId).not.toBe(created.config.dbId);
        current = replacement.config;
      }
      expect(bindingFor(current)).not.toBe(binding);
      await expect(
        Storage.getTokens({
          userId: author.id,
          serverName: created.serverName,
          binding: bindingFor(current),
          findToken: methods.findToken,
        }),
      ).rejects.toThrow('Re-authentication required');
      remote.requests.length = 0;
      const result = await inspect(created.serverName, current, manager);
      expect(result).toMatchObject({ tools: null, oauthRequired: true, oauthUrl: null });
      expect(remote.requests.some((request) => request.authorization)).toBe(false);
      expect(remote.getToolCalls()).toBe(0);
      expect(await manager.getFlowState(tokenFlowId, 'mcp_get_tokens')).toMatchObject({
        status: 'COMPLETED',
        result: { access_token: accessToken },
      });
    } finally {
      await remote.close();
    }
  },
);

it('preserves authorization for an unchanged target after a cosmetic edit', async () => {
  const remote = await createRemote();
  try {
    const database = new Database(mongoose);
    const registry = new Registry(mongoose, [remote.origin]);
    const manager = new FlowManager<MCPOAuthTokens | null>(new Keyv(), { ttl: 30000, ci: true });
    const created = await database.add(
      'original',
      {
        type: 'streamable-http',
        url: `${remote.origin}/original`,
        title: 'Managed',
        oauth: {},
        requiresOAuth: true,
      },
      author.id,
    );
    await authorize(created.serverName, created.config);
    expect((await inspect(created.serverName, created.config, manager)).tools).toHaveLength(1);
    const updated: MCPOptions = {
      type: 'streamable-http',
      url: `${remote.origin}/original`,
      title: 'Renamed connection',
      description: 'Updated display description',
      oauth: {},
    };
    MCPServerUserInputSchema.parse(updated);
    await registry.updateServer(created.serverName, updated, 'DB', editor.id, async (persist) =>
      persist(),
    );
    const current = await database.get(created.serverName, author.id);
    if (!current) throw new Error('Cosmetically edited connection was not persisted');
    expect(bindingFor(current)).toBe(bindingFor(created.config));
    const result = await inspect(created.serverName, current, manager);
    expect(result.oauthRequired).toBe(false);
    expect(result.tools?.map((tool) => tool.name)).toEqual(['echo']);
    expect(remote.getToolCalls()).toBe(0);
  } finally {
    await remote.close();
  }
});

it('binds authorization to canonical target, transport, connection identity, and OAuth settings', () => {
  const config: ParsedServerConfig = {
    dbId: '507f1f77bcf86cd799439011',
    type: 'streamable-http',
    url: 'https://REMOTE.example:443',
    oauth: { client_id: 'client', scope: 'read' },
  };
  const binding = bindingFor(config);
  expect(binding).toBeDefined();
  expect(bindingFor({ ...config, url: 'https://remote.example/' })).toBe(binding);
  expect(bindingFor({ ...config, title: 'A new title', description: 'New description' })).toBe(
    binding,
  );
  expect(bindingFor({ ...config, oauth: { scope: 'read', client_id: 'client' } })).toBe(binding);
  expect(bindingFor({ ...config, url: 'https://another.example/' })).not.toBe(binding);
  expect(bindingFor({ ...config, dbId: '507f1f77bcf86cd799439012' })).not.toBe(binding);
  expect(bindingFor({ ...config, type: 'sse' })).not.toBe(binding);
  expect(bindingFor({ ...config, oauth: { client_id: 'another-client', scope: 'read' } })).not.toBe(
    binding,
  );
  expect(bindingFor({ ...config, oauth: { client_id: 'client', scope: 'write' } })).not.toBe(
    binding,
  );
  const confidential = bindingFor({
    ...config,
    oauth: { ...config.oauth, client_secret: 'confidential-client-secret' },
  });
  expect(confidential).not.toBe(binding);
  expect(confidential).not.toContain('confidential-client-secret');
});

it('keeps ordinary LibreChat token storage and flow identity unchanged outside governed mode', async () => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'false';
  const config: ParsedServerConfig = {
    dbId: '507f1f77bcf86cd799439011',
    type: 'streamable-http',
    url: 'https://remote.example/mcp',
    oauth: {},
  };
  expect(bindingFor(config)).toBeUndefined();
  expect(OAuth.generateTokenFlowId(author.id, 'ordinary', undefined, bindingFor(config))).toBe(
    OAuth.generateFlowId(author.id, 'ordinary'),
  );
  await Storage.storeTokens({
    userId: author.id,
    serverName: 'ordinary',
    tokens: { access_token: accessToken, token_type: 'Bearer' },
    createToken: methods.createToken,
  });
  expect(
    await Storage.getTokens({
      userId: author.id,
      serverName: 'ordinary',
      findToken: methods.findToken,
    }),
  ).toMatchObject({ access_token: accessToken });
});
