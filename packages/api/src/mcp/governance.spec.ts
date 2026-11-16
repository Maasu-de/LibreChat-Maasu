import { getTenantId, createMCPGovernanceIdentityModel } from '@librechat/data-schemas';
import type { ParsedServerConfig } from './types';
import {
  governanceConnectionId,
  governanceDefinition,
  governanceToolDefinition,
  publishMCPGovernance,
} from './governance';

jest.mock('@librechat/data-schemas', () => ({
  getTenantId: jest.fn(() => 'tenant-a'),
  createMCPGovernanceIdentityModel: jest.fn(),
  logger: { warn: jest.fn() },
}));

const config: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://user:password@tools.example/mcp?token=secret&region=eu',
  dbId: 'persistent-mcp-id',
  requiresOAuth: true,
  oauth: {
    authorization_url: 'https://auth.example/authorize',
    token_url: 'https://auth.example/token',
    client_id: 'public-client-id',
    client_secret: 'client-secret',
    scope: 'tools.write tools.read',
  },
  headers: { Authorization: 'Bearer credential' },
  serverInstructions: 'Read the project before editing',
};

describe('MCP governance bridge', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock;
    process.env.GOVERNANCE_MCP_METADATA_URL = 'http://gateway/internal/mcp/connections';
    process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'service-credential';
    fetchMock.mockResolvedValue({ ok: true });
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('publishes only non-secret security-relevant configuration', () => {
    const definition = governanceDefinition(config);
    expect(definition).toMatchObject({
      endpoint: 'https://tools.example/mcp?region=eu&token=%5BREDACTED%5D',
      transport: 'streamable-http',
      authentication: { mode: 'oauth', oauth: { client_id: 'public-client-id' } },
      authorization_scope: ['tools.read', 'tools.write'],
      server_instructions: config.serverInstructions,
    });
    const serialized = JSON.stringify(definition);
    for (const secret of ['password', 'client-secret', 'Bearer credential', 'user:']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('ignores display, ownership, status and credential rotation', () => {
    expect(
      governanceDefinition({
        ...config,
        url: config.url!.replace('secret', 'rotated-token'),
        title: 'New display title',
        description: 'Display description',
        iconPath: 'different.svg',
        author: 'new-owner',
        oauth: { ...config.oauth, client_secret: 'rotated-secret' },
        headers: { Authorization: 'Bearer rotated' },
        inspectionFailed: true,
      }),
    ).toEqual(governanceDefinition(config));
  });

  it('excludes environment values and credentials in stdio arguments', () => {
    const definition = governanceDefinition({
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--token', 'private', '--api-key=private', '--project', 'public'],
      env: { API_KEY: 'private' },
    });
    expect(definition.args).toEqual(['server.js', '--project', 'public']);
    expect(JSON.stringify(definition)).not.toContain('private');
  });

  it('redacts header arguments and detects authentication scheme changes', () => {
    const definition = governanceDefinition({
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--header', 'Authorization: Bearer private', '-H=X-Api-Key: private'],
    });
    expect(definition.args).toEqual([
      'server.js',
      '--header',
      'authorization: bearer [REDACTED]',
      '-H=x-api-key: [REDACTED]',
    ]);
    expect(JSON.stringify(definition)).not.toContain('private');
    const headerConfig: ParsedServerConfig = {
      type: 'sse',
      url: 'https://mcp.example',
      headers: { Authorization: 'Bearer private' },
    };
    expect(governanceDefinition(headerConfig).authentication.authorization_type).toBe('bearer');
    expect(
      governanceDefinition({ ...headerConfig, headers: { Authorization: 'Basic private' } })
        .authentication.authorization_type,
    ).toBe('basic');
  });

  it('removes tool private metadata and preserves schema property names', () => {
    const tool = governanceToolDefinition({
      name: 'search',
      inputSchema: { type: 'object', properties: { token: { type: 'string' } } },
      _meta: { token: 'private', nested: { api_key: 'private', security: ['read'] } },
      credentials: 'private',
    });
    expect(tool._meta).toEqual({ nested: { security: ['read'] } });
    expect(tool.inputSchema.properties).toHaveProperty('token');
    expect(JSON.stringify(tool)).not.toContain('private');
  });

  it('uses the persistent server ID and preserves raw tool schemas and annotations', async () => {
    const tools = [
      {
        name: 'search',
        description: 'Find records',
        inputSchema: { type: 'object' as const, properties: { token: { type: 'string' } } },
        outputSchema: { type: 'object' as const, properties: { count: { type: 'number' } } },
        annotations: { readOnlyHint: true },
      },
    ];
    await publishMCPGovernance('search-server', config, tools, 'user-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway/internal/mcp/connections/persistent-mcp-id',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      name: 'search-server',
      tools,
      actor: { issuer: 'librechat', user_id: 'user-1' },
    });
    expect(createMCPGovernanceIdentityModel).not.toHaveBeenCalled();
  });

  it('distinguishes an authoritative empty list from skipped discovery', async () => {
    await publishMCPGovernance('server', config, []);
    await publishMCPGovernance('server', config);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toEqual([]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('tools');
  });

  it('marks removed connections unavailable and tolerates publication errors', async () => {
    await publishMCPGovernance('server', config, null, undefined, false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).available).toBe(false);
    fetchMock.mockRejectedValue(new Error('external server failure'));
    await expect(publishMCPGovernance('server', config)).resolves.toBeUndefined();
  });

  it('keeps operator identity scoped to tenant, source and name across definition changes', async () => {
    const findOneAndUpdate = jest.fn(
      (_filter: { _id: object }, _update: object, _options: object) => ({
        lean: async () => ({ _id: 'operator-id' }),
      }),
    );
    jest.mocked(createMCPGovernanceIdentityModel).mockReturnValue({
      findOneAndUpdate,
    } as ReturnType<typeof createMCPGovernanceIdentityModel>);
    const operator: ParsedServerConfig = { ...config, dbId: undefined, source: 'config' };
    expect(await governanceConnectionId('server', operator)).toBe('operator-id');
    expect(
      await governanceConnectionId('server', { ...operator, url: 'https://changed.example' }),
    ).toBe('operator-id');
    expect(findOneAndUpdate.mock.calls[0]).toEqual(findOneAndUpdate.mock.calls[1]);
    await governanceConnectionId('server', { ...operator, source: 'yaml' });
    expect(findOneAndUpdate.mock.calls[0]).toEqual(findOneAndUpdate.mock.calls[2]);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: expect.any(Object) },
      { $setOnInsert: { tenantId: 'tenant-a', source: 'operator', serverName: 'server' } },
      { upsert: true, new: true },
    );
    jest.mocked(getTenantId).mockReturnValueOnce('tenant-b');
    await governanceConnectionId('server', operator);
    expect(findOneAndUpdate.mock.calls[3][0]).not.toEqual(findOneAndUpdate.mock.calls[0][0]);
  });

  it('does nothing when the bridge is not configured', async () => {
    delete process.env.GOVERNANCE_MCP_METADATA_URL;
    await publishMCPGovernance('server', config);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
