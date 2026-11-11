import express from 'express';
import request from 'supertest';
import { MCPServerUserInputSchema } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  isGovernanceMCPApi,
  isGovernanceRemoteMCP,
  requireGovernanceMCPAdministrator,
  requireGovernanceMCPAdministration,
  createGovernanceMCPHandlers,
} from '../mcp';
import { enforceGovernancePilot } from '../pilot';

type Actor = Pick<IUser, 'provider' | 'role' | 'openidIssuer' | 'openidId'>;
const environment = process.env;
const administrator: Actor = {
  provider: 'openid',
  role: 'GOVERNANCE_ADMIN',
  openidIssuer: 'https://identity.example',
  openidId: 'administrator',
};

beforeEach(() => {
  process.env = {
    ...environment,
    GOVERNANCE_PILOT_ENABLED: 'true',
    GOVERNANCE_MCP_AUDIT_URL: 'https://gateway.example/internal/mcp-audit',
    LIBRECHAT_SERVICE_CREDENTIAL: 'test-credential',
  };
});
afterEach(() => {
  process.env = environment;
});

function app(actor: Actor | undefined = administrator) {
  const server = express();
  server.use('/api', enforceGovernancePilot);
  server.use('/api/mcp', (req, _res, next) => {
    Object.assign(req, { user: actor });
    next();
  });
  server.use('/api/mcp', requireGovernanceMCPAdministrator);
  server.use((_req, res) => {
    res.sendStatus(204);
  });
  return server;
}

describe('governed MCP administration boundary', () => {
  it.each([
    ['get', '/servers'],
    ['post', '/servers'],
    ['get', '/servers/remote'],
    ['patch', '/servers/remote'],
    ['delete', '/servers/remote'],
    ['get', '/servers/remote/inspect'],
    ['get', '/connection/status'],
    ['get', '/connection/status/remote'],
    ['post', '/remote/reinitialize'],
    ['get', '/remote/oauth/initiate'],
    ['post', '/remote/oauth/bind'],
    ['get', '/oauth/status/flow'],
    ['post', '/oauth/cancel/remote'],
    ['post', '/remote/oauth/revoke'],
  ] as const)('permits the required administrative endpoint %s %s', async (method, path) => {
    await expect(request(app())[method](`/api/mcp${path}`)).resolves.toMatchObject({ status: 204 });
  });

  it.each([
    ['get', '/tools'],
    ['get', '/oauth/tokens/flow'],
    ['get', '/remote/auth-values'],
    ['post', '/remote/call'],
    ['post', '/servers/remote/tools/tool'],
    ['put', '/servers/remote'],
    ['post', '/servers/remote/inspect'],
    ['get', '/servers/remote/share'],
  ] as const)(
    'blocks execution, secret retrieval and sharing endpoint %s %s',
    async (method, path) => {
      await expect(request(app())[method](`/api/mcp${path}`)).resolves.toMatchObject({
        status: 403,
      });
    },
  );

  it.each([
    { provider: 'openid', role: 'USER' },
    { provider: 'openid', role: 'ADMIN' },
    { provider: 'local', role: 'GOVERNANCE_ADMIN' },
  ])('denies MCP administration to %j', async (identity) => {
    const server = app({ ...administrator, ...identity });
    await expect(request(server).get('/api/mcp/servers')).resolves.toMatchObject({ status: 403 });
    await request(server).post('/api/mcp/servers').send({}).expect(403);
    await request(server).patch('/api/mcp/servers/remote').send({}).expect(403);
    await request(server).delete('/api/mcp/servers/remote').expect(403);
    await request(server).get('/api/mcp/servers/remote/inspect').expect(403);
    await request(server).post('/api/mcp/remote/oauth/revoke').expect(403);
  });

  it('fails closed without an auditable OIDC identity', async () => {
    await expect(
      request(app({ ...administrator, openidId: undefined })).post('/api/mcp/servers'),
    ).resolves.toMatchObject({ status: 503 });
    delete process.env.LIBRECHAT_SERVICE_CREDENTIAL;
    await request(app()).get('/api/mcp/servers').expect(503);
  });

  it('allows only the OAuth callback in the unauthenticated callback route family', () => {
    expect(isGovernanceMCPApi('GET', '/mcp/remote/oauth/callback')).toBe(true);
    expect(isGovernanceMCPApi('POST', '/mcp/remote/oauth/callback')).toBe(false);
    expect(isGovernanceMCPApi('GET', '/mcp/remote/oauth/tokens')).toBe(false);
    expect(isGovernanceMCPApi('GET', '/mcp/oauth/tokens/flow')).toBe(false);
  });

  it('leaves non-governed MCP permissions with the existing application', async () => {
    process.env.GOVERNANCE_PILOT_ENABLED = 'false';
    await expect(
      request(app({ ...administrator, role: 'USER' })).get('/api/mcp/tools'),
    ).resolves.toMatchObject({ status: 204 });
  });

  it.each(['USER', 'ADMIN', 'GOVERNANCE_ADMIN'])(
    'does not add administration endpoints outside governed mode for %s',
    async (role) => {
      process.env.GOVERNANCE_PILOT_ENABLED = 'false';
      const server = express();
      server.use((req, _res, next) => {
        Object.assign(req, { user: { ...administrator, role } });
        next();
      });
      server.use(requireGovernanceMCPAdministration);
      server.use((_req, res) => {
        res.sendStatus(204);
      });
      await expect(request(server).get('/servers/remote/inspect')).resolves.toMatchObject({
        status: 404,
      });
      await expect(request(server).post('/remote/oauth/revoke')).resolves.toMatchObject({
        status: 404,
      });
    },
  );

  it('allows the governed-only endpoint guard for an OIDC governance administrator', async () => {
    const server = express();
    server.use((req, _res, next) => {
      Object.assign(req, { user: administrator });
      next();
    });
    server.use(requireGovernanceMCPAdministration);
    server.use((_req, res) => {
      res.sendStatus(204);
    });
    await expect(request(server).get('/servers/remote/inspect')).resolves.toMatchObject({
      status: 204,
    });
  });

  it('blocks MCP ACL management while preserving the existing agent ACL boundary', async () => {
    await expect(
      request(app()).put('/api/permissions/mcpServer/connection'),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      request(app()).get('/api/permissions/mcpServer/connection'),
    ).resolves.toMatchObject({ status: 403 });
    await expect(request(app()).get('/api/permissions/agent/agent-id')).resolves.toMatchObject({
      status: 204,
    });
    await expect(request(app()).put('/api/permissions/agent/agent-id')).resolves.toMatchObject({
      status: 204,
    });
  });
});

describe('remote administrative connection input', () => {
  it.each(['streamable-http', 'http', 'sse'])(
    'accepts remote %s without user credentials',
    (type) => {
      const config = MCPServerUserInputSchema.parse({ type, url: 'https://mcp.example/server' });
      expect(isGovernanceRemoteMCP(config)).toBe(true);
    },
  );

  it('accepts administrator credentials and leaves response redaction to existing storage', () => {
    const config = MCPServerUserInputSchema.parse({
      type: 'streamable-http',
      url: 'https://mcp.example/server',
      apiKey: { source: 'admin', key: 'service-secret', authorization_type: 'bearer' },
    });
    expect(isGovernanceRemoteMCP(config)).toBe(true);
  });

  it.each([
    { type: 'websocket', url: 'wss://mcp.example/server' },
    { url: 'https://username:password@mcp.example/server' },
    { url: 'https://mcp.example/server?api_key=secret' },
    { headers: { Authorization: 'Bearer service-secret' } },
    { apiKey: { source: 'user', authorization_type: 'bearer' } },
    { obo: { scopes: 'tool.read' } },
  ])('rejects unsupported transports and unprotected credentials: %j', (override) => {
    const config = MCPServerUserInputSchema.parse({
      type: 'streamable-http',
      url: 'https://mcp.example/server',
      ...override,
    });
    expect(isGovernanceRemoteMCP(config)).toBe(false);
  });

  it('rejects local execution before administrative connection validation', () => {
    expect(
      MCPServerUserInputSchema.safeParse({ type: 'stdio', command: 'sh', args: ['-c', 'id'] })
        .success,
    ).toBe(false);
  });

  it.each(['authorization_url', 'token_url', 'revocation_endpoint', 'redirect_uri'])(
    'rejects credentials embedded in OAuth %s URLs',
    (field) => {
      for (const url of [
        'https://client:secret@identity.example/oauth',
        'https://identity.example/oauth?client_secret=secret',
        'https://identity.example/oauth#secret',
      ]) {
        const config = MCPServerUserInputSchema.parse({
          type: 'streamable-http',
          url: 'https://mcp.example/server',
          oauth: { [field]: url },
        });
        expect(isGovernanceRemoteMCP(config)).toBe(false);
      }
    },
  );
});

describe('administrative inspection and revocation', () => {
  const actorId = 'a'.repeat(24);
  const config: ParsedServerConfig = {
    type: 'streamable-http',
    url: 'https://mcp.example/server',
    dbId: 'b'.repeat(24),
    source: 'user',
    apiKey: { source: 'admin', key: 'service-secret', authorization_type: 'bearer' },
  };
  const tools = [
    {
      name: 'example_tool',
      description: 'An example tool',
      inputSchema: { type: 'object' as const, properties: { name: { type: 'string' } } },
      annotations: { title: 'Internal title omitted from inspection response' },
    },
  ];
  function setup() {
    process.env.GOVERNANCE_PILOT_ENABLED = 'false';
    const getServerConfig = jest.fn().mockResolvedValue(config);
    const disconnectUserConnection = jest.fn().mockResolvedValue(undefined);
    const discover = jest.fn().mockResolvedValue({ oauthRequired: false, oauthUrl: null, tools });
    const revoke = jest.fn().mockResolvedValue(undefined);
    const handlers = createGovernanceMCPHandlers({
      getRegistry: () => ({ getServerConfig }),
      getManager: () => ({ disconnectUserConnection }),
      discover,
      revoke,
    });
    const server = express();
    server.use((req, _res, next) => {
      Object.assign(req, { user: { ...administrator, id: actorId } });
      next();
    });
    server.get('/inspect/:serverName', handlers.inspect);
    server.post('/revoke/:serverName', handlers.revoke);
    return { server, getServerConfig, disconnectUserConnection, discover, revoke };
  }

  it.each([true, false])(
    'reports failed discovery separately from a valid empty list: %s',
    async (failed) => {
      const { server, discover } = setup();
      discover.mockResolvedValueOnce({
        tools: failed ? null : [],
        oauthRequired: false,
        oauthUrl: null,
      });
      const response = await request(server).get('/inspect/remote');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: !failed, tools: [] });
    },
  );

  it('returns discovered tool definitions without credentials or internal metadata', async () => {
    const { server, getServerConfig, discover } = setup();
    const response = await request(server).get('/inspect/remote');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      tools: [
        {
          name: tools[0].name,
          description: tools[0].description,
          inputSchema: tools[0].inputSchema,
        },
      ],
    });
    expect(getServerConfig).toHaveBeenCalledWith('remote', actorId);
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'remote',
        user: expect.objectContaining({ id: actorId }),
        serverConfig: config,
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain('service-secret');
  });

  it('reports an inspection error without returning provider messages or tools', async () => {
    const { server, discover } = setup();
    discover.mockRejectedValue(new Error('Provider echoed service-secret'));
    const response = await request(server).get('/inspect/remote');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      tools: [],
      message: 'MCP connection inspection failed',
    });
  });

  it('does not report successful authenticated inspection while OAuth is required', async () => {
    const { server, discover } = setup();
    discover.mockResolvedValue({ oauthRequired: true, oauthUrl: null, tools });
    const response = await request(server).get('/inspect/remote');
    expect(response.body).toEqual({ success: false, tools: [] });
  });

  it('revokes and disconnects only the requesting administrator', async () => {
    const { server, revoke, disconnectUserConnection } = setup();
    const response = await request(server).post('/revoke/remote');
    expect(response.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(actorId, 'mcp_remote', undefined);
    expect(disconnectUserConnection).toHaveBeenCalledWith(actorId, 'remote');
    expect(response.body).toEqual({ success: true });
  });

  it('reports revocation failure without provider token details', async () => {
    const { server, revoke } = setup();
    revoke.mockRejectedValue(new Error('Provider echoed refresh-token'));
    const response = await request(server).post('/revoke/remote');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'MCP OAuth revocation failed' });
  });
});
