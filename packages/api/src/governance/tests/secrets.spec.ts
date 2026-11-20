import { logger } from '@librechat/data-schemas';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  McpError,
  ErrorCode,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPConnection } from '~/mcp/connection';
import { MCPOAuthHandler } from '~/mcp/oauth';
import { createOAuthMCPServer } from '~/mcp/__tests__/helpers/oauthTestServer';

const environment = process.env;

afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

it.each([true, false])('protects OAuth flow secrets in governed logs %s', async (governed) => {
  process.env = { ...environment, GOVERNANCE_PILOT_ENABLED: String(governed) };
  const debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
  const server = await createOAuthMCPServer();
  try {
    const result = await MCPOAuthHandler.initiateOAuthFlow(
      'inspection-fixture',
      server.url,
      'administrator',
      {},
      undefined,
      [server.url],
    );
    const clientSecret = result.flowMetadata.clientInfo?.client_secret;
    const codeVerifier = result.flowMetadata.codeVerifier;
    if (!clientSecret || !codeVerifier) throw new Error('OAuth test flow is missing credentials');
    const logged = JSON.stringify(debug.mock.calls);
    expect(logged.includes(clientSecret)).toBe(!governed);
    expect(logged.includes(codeVerifier)).toBe(!governed);
  } finally {
    await server.close();
  }
});

it.each([true, false])(
  'protects credential-bearing inspection errors in governed mode %s',
  async (governed) => {
    process.env = { ...environment, GOVERNANCE_PILOT_ENABLED: String(governed) };
    const errors = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const server = new Server(
      { name: 'inspection-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const connection = new MCPConnection({
      serverName: 'inspection-fixture',
      serverConfig: { type: 'streamable-http', url: 'https://mcp.example/server' },
      useSSRFProtection: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let listCount = 0;
    let callCount = 0;
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      listCount++;
      throw new McpError(
        ErrorCode.InternalError,
        'Provider echoed Bearer confidential-service-key',
      );
    });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      callCount++;
      return { content: [] };
    });
    try {
      await server.connect(serverTransport);
      await connection.client.connect(clientTransport);
      if (governed)
        await expect(connection.fetchTools(true)).rejects.toThrow('MCP tool discovery failed');
      else await expect(connection.fetchTools()).resolves.toEqual([]);
      expect(listCount).toBe(1);
      expect(callCount).toBe(0);
      const logged = JSON.stringify(errors.mock.calls);
      expect(errors).toHaveBeenCalled();
      expect(logged.includes('confidential-service-key')).toBe(!governed);
    } finally {
      await connection.client.close();
      await server.close();
    }
  },
);
