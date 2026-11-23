import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPConnection } from '~/mcp/connection';
import type { ParsedServerConfig } from '~/mcp/types';
import { trackSockets } from '~/mcp/__tests__/helpers/oauthTestServer';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPServerInspector } from '../MCPServerInspector';

const environment = process.env;

beforeEach(() => {
  process.env = { ...environment, GOVERNANCE_PILOT_ENABLED: 'true' };
});

afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

it.each([false, true])(
  'ends temporary SSE inspection without reconnecting (service credential: %s)',
  async (authenticated) => {
    const sessions = new Map<string, SSEServerTransport>();
    const servers = new Set<Server>();
    const requests: (string | undefined)[] = [];
    let toolCalls = 0;
    const remote = http.createServer(async (req, res) => {
      requests.push(req.headers.authorization);
      if (authenticated && req.headers.authorization !== 'Bearer inspection-service-key') {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/messages') {
        const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) {
          res.writeHead(404).end();
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      if (req.method !== 'GET' || url.pathname !== '/sse') {
        res.writeHead(404).end();
        return;
      }
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, transport);
      res.on('close', () => sessions.delete(transport.sessionId));
      const server = new Server(
        { name: 'inspection-lifecycle', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      servers.add(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: 'lookup', description: 'Look up a record', inputSchema: { type: 'object' } },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => {
        toolCalls++;
        return { content: [] };
      });
      await server.connect(transport);
    });
    const closeServer = trackSockets(remote);
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('MCP fixture has no TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    const config: ParsedServerConfig = {
      type: 'sse',
      url: `${origin}/sse`,
      requiresOAuth: false,
      ...(authenticated && {
        apiKey: { source: 'admin', authorization_type: 'bearer', key: 'inspection-service-key' },
      }),
    };
    const create = jest.spyOn(MCPConnectionFactory, 'create');
    try {
      const inspected = await MCPServerInspector.inspect(
        'temporary-inspection',
        config,
        undefined,
        [origin],
      );
      expect(inspected.tools).toBe('lookup');
      expect(inspected.toolFunctions?.['lookup_mcp_temporary-inspection']).toMatchObject({
        function: { description: 'Look up a record', parameters: { type: 'object' } },
      });
      const completedRequests = requests.length;
      expect(completedRequests).toBeGreaterThan(0);
      expect(
        requests.every(
          (header) => header === (authenticated ? 'Bearer inspection-service-key' : undefined),
        ),
      ).toBe(true);

      await new Promise<void>((resolve) => setTimeout(resolve, 3250));

      expect(requests).toHaveLength(completedRequests);
      expect(toolCalls).toBe(0);
    } finally {
      for (const result of create.mock.results) {
        if (result.type === 'return') {
          const connection: MCPConnection = await result.value;
          await connection.dispose();
        }
      }
      await Promise.all([...servers].map((server) => server.close()));
      await closeServer();
    }
  },
);
