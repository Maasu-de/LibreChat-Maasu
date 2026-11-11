import http from 'node:http';
import { Keyv } from 'keyv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  McpError,
  ErrorCode,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { IUser } from '@librechat/data-schemas';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import {
  InMemoryTokenStore,
  createOAuthMCPServer,
  trackSockets,
} from '~/mcp/__tests__/helpers/oauthTestServer';

let factory: typeof import('~/mcp/MCPConnectionFactory').MCPConnectionFactory;
let tokens: typeof import('~/mcp/oauth').MCPTokenStorage;
let oauth: typeof import('~/mcp/oauth').MCPOAuthHandler;
let FlowManager: typeof import('~/flow/manager').FlowStateManager;
const environment = process.env;
const serverName = 'administrative-inspection';
const administrator = { id: 'administrator', role: 'GOVERNANCE_ADMIN' } as IUser;

beforeAll(async () => {
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';
  factory = (await import('~/mcp/MCPConnectionFactory')).MCPConnectionFactory;
  ({ MCPTokenStorage: tokens, MCPOAuthHandler: oauth } = await import('~/mcp/oauth'));
  FlowManager = (await import('~/flow/manager')).FlowStateManager;
});

beforeEach(() => {
  process.env = { ...process.env, GOVERNANCE_PILOT_ENABLED: 'true' };
});

afterAll(() => {
  process.env = environment;
});

it.each([false, true])(
  'passively inspects OAuth using only the current administrator authorization: %s',
  async (authorized) => {
    const remote = await createOAuthMCPServer();
    const store = new InMemoryTokenStore();
    const manager = new FlowManager<MCPOAuthTokens | null>(new Keyv(), { ttl: 30000, ci: true });
    for (const userId of [
      'system',
      'another-administrator',
      ...(authorized ? [administrator.id] : []),
    ]) {
      const accessToken = `authorization-for-${userId}`;
      remote.issuedTokens.add(accessToken);
      remote.tokenIssueTimes.set(accessToken, Date.now());
      await tokens.storeTokens({
        userId,
        serverName,
        tokens: { access_token: accessToken, token_type: 'Bearer' },
        createToken: store.createToken,
      });
    }
    const oauthStart = jest.fn();
    let connection: Awaited<ReturnType<typeof factory.discoverTools>>['connection'] = null;
    try {
      const result = await factory.discoverTools(
        {
          serverName,
          dbSourced: true,
          useSSRFProtection: false,
          serverConfig: {
            type: 'streamable-http',
            url: remote.url,
            oauth: {},
            requiresOAuth: true,
            initTimeout: 2000,
          },
        },
        {
          user: administrator,
          useOAuth: true,
          flowManager: manager,
          tokenMethods: store,
          oauthStart,
        },
        true,
      );
      connection = result.connection;
      expect(result.oauthRequired).toBe(!authorized);
      if (authorized) expect(result.tools?.map((tool) => tool.name)).toEqual(['echo']);
      else expect(result.tools).toBeNull();
      expect(result.oauthUrl).toBeNull();
      expect(oauthStart).not.toHaveBeenCalled();
      expect(remote.registeredClients.size).toBe(0);
      expect(
        await manager.getFlowState(oauth.generateFlowId(administrator.id, serverName), 'mcp_oauth'),
      ).toBeUndefined();
    } finally {
      await connection?.disconnect();
      await remote.close();
    }
  },
);

it.each([false, true])(
  'distinguishes an empty SDK tool list from an authenticated listing failure: %s',
  async (failed) => {
    const transports = new Set<StreamableHTTPServerTransport>();
    let toolCalls = 0;
    const listingAuthorization: (string | undefined)[] = [];
    const server = http.createServer(async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      transports.add(transport);
      const sdk = new Server(
        { name: serverName, version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      sdk.setRequestHandler(ListToolsRequestSchema, async () => {
        listingAuthorization.push(req.headers.authorization);
        if (failed && req.headers.authorization) {
          throw new McpError(ErrorCode.InternalError, 'Provider echoed confidential-service-key');
        }
        return { tools: [] };
      });
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
    let connection: Awaited<ReturnType<typeof factory.discoverTools>>['connection'] = null;
    try {
      const discovery = factory.discoverTools(
        {
          serverName,
          dbSourced: true,
          useSSRFProtection: false,
          serverConfig: {
            type: 'streamable-http',
            url: `http://127.0.0.1:${address.port}/mcp`,
            initTimeout: 2000,
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
              key: 'confidential-service-key',
            },
          },
        },
        { user: administrator },
        true,
      );
      if (failed) {
        await expect(discovery).rejects.toThrow('MCP tool discovery failed');
      } else {
        const result = await discovery;
        connection = result.connection;
        expect(result).toMatchObject({ tools: [], oauthRequired: false, oauthUrl: null });
      }
      expect(listingAuthorization).toEqual(['Bearer confidential-service-key']);
      expect(toolCalls).toBe(0);
    } finally {
      await connection?.disconnect();
      await Promise.all([...transports].map((transport) => transport.close()));
      await closeServer();
    }
  },
);
