const mockGetTokens = jest.fn();
const mockDeleteUserTokens = jest.fn();
const mockGetClientInfoAndMetadata = jest.fn();
const mockRevokeOAuthToken = jest.fn();
const mockGetServerConfig = jest.fn();
const mockGetOAuthServers = jest.fn();
const mockGetAllowedDomains = jest.fn();
const mockGetAllowedAddresses = jest.fn();
const mockDeleteFlow = jest.fn();
const mockGetLogStores = jest.fn();
const mockFindToken = jest.fn();
const mockDeleteTokens = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockGetTenantId = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
  getTenantId: (...args) => mockGetTenantId(...args),
  webSearchKeys: [],
}));

jest.mock('@librechat/api', () => {
  return {
    MCPOAuthHandler: {
      revokeOAuthToken: (...args) => mockRevokeOAuthToken(...args),
      generateFlowId: (userId, serverName, tenantId) => {
        const flowId = `${userId}:${serverName}`;
        return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
      },
      generateTokenFlowId: (userId, serverName, tenantId) => {
        const flowId = `${userId}:${serverName}`;
        return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
      },
    },
    MCPTokenStorage: {
      getTokens: (...args) => mockGetTokens(...args),
      getClientInfoAndMetadata: (...args) => mockGetClientInfoAndMetadata(...args),
      deleteUserTokens: (...args) => mockDeleteUserTokens(...args),
    },
    isGovernancePilotEnabled: () => process.env.GOVERNANCE_PILOT_ENABLED === 'true',
    sanitizeMCPErrorForLogging: (error) =>
      process.env.GOVERNANCE_PILOT_ENABLED === 'true' ? 'MCP operation failed' : error,
    normalizeHttpError: jest.fn(),
    extractWebSearchEnvVars: jest.fn(),
    needsRefresh: jest.fn(),
    getNewS3URL: jest.fn(),
  };
});

jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(() => ({
    deleteFlow: (...args) => mockDeleteFlow(...args),
  })),
  getMCPServersRegistry: jest.fn(() => ({
    getServerConfig: (...args) => mockGetServerConfig(...args),
    getOAuthServers: (...args) => mockGetOAuthServers(...args),
    getAllowedDomains: (...args) => mockGetAllowedDomains(...args),
    getAllowedAddresses: (...args) => mockGetAllowedAddresses(...args),
  })),
}));

jest.mock('~/cache', () => ({
  getLogStores: (...args) => mockGetLogStores(...args),
}));

jest.mock('~/server/services/PluginService', () => ({
  updateUserPluginAuth: jest.fn(),
  deleteUserPluginAuth: jest.fn(),
}));

jest.mock('~/server/services/twoFactorService', () => ({
  verifyOTPOrBackupCode: jest.fn(),
}));

jest.mock('~/server/services/AuthService', () => ({
  verifyEmail: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));

jest.mock('~/server/services/Config/getCachedTools', () => ({
  invalidateCachedTools: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
}));

jest.mock('~/models', () => ({
  findToken: (...args) => mockFindToken(...args),
  deleteTokens: (...args) => mockDeleteTokens(...args),
  updateUser: jest.fn(),
  deleteAllUserSessions: jest.fn(),
  deleteAllSharedLinks: jest.fn(),
  updateUserPlugins: jest.fn(),
  deleteUserById: jest.fn(),
  deleteMessages: jest.fn(),
  deletePresets: jest.fn(),
  deleteUserKey: jest.fn(),
  getUserById: jest.fn(),
  deleteConvos: jest.fn(),
  deleteFiles: jest.fn(),
  getFiles: jest.fn(),
  deleteToolCalls: jest.fn(),
  deleteUserAgents: jest.fn(),
  deleteUserPrompts: jest.fn(),
  deleteTransactions: jest.fn(),
  deleteBalances: jest.fn(),
  deleteAllAgentApiKeys: jest.fn(),
  deleteAssistants: jest.fn(),
  deleteConversationTags: jest.fn(),
  deleteAllUserMemories: jest.fn(),
  deleteActions: jest.fn(),
  removeUserFromAllGroups: jest.fn(),
  deleteAclEntries: jest.fn(),
  getSoleOwnedResourceIds: jest.fn().mockResolvedValue([]),
}));

const { maybeUninstallOAuthMCP } = require('~/server/controllers/UserController');

const userId = 'user-123';
const pluginKey = 'mcp_acme';
const serverName = 'acme';

const serverConfig = {
  url: 'https://acme.example.com',
  oauth: {
    revocation_endpoint: 'https://acme.example.com/revoke',
    revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
  },
  oauth_headers: { 'X-Tenant': 'acme' },
};

const appConfig = {
  mcpServers: { acme: serverConfig },
};

const clientInfo = { client_id: 'cid', client_secret: 'csec' };
const clientMetadata = {};

function setupOAuthServerFound() {
  mockGetServerConfig.mockResolvedValue(serverConfig);
  mockGetOAuthServers.mockResolvedValue(new Set([serverName]));
  mockGetAllowedDomains.mockReturnValue(['https://acme.example.com']);
  mockGetAllowedAddresses.mockReturnValue(null);
  mockGetClientInfoAndMetadata.mockResolvedValue({ clientInfo, clientMetadata });
}

describe('maybeUninstallOAuthMCP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantId.mockReturnValue(undefined);
  });

  test.each([false, true])(
    'commits governed local revocation before provider calls; commit failure: %s',
    async (failCommit) => {
      setupOAuthServerFound();
      mockGetTokens.mockResolvedValue({ access_token: 'access', refresh_token: 'refresh' });
      mockDeleteUserTokens.mockResolvedValue(undefined);
      mockDeleteFlow.mockResolvedValue(undefined);
      let committed = false;
      const session = { id: 'transaction-session' };
      mockRevokeOAuthToken.mockImplementation(async () => {
        expect(committed).toBe(true);
      });
      const commit = jest.fn(async (deleteStoredTokens) => {
        expect(mockDeleteFlow).toHaveBeenCalled();
        expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
        if (failCommit) throw new Error('audit unavailable');
        mockDeleteUserTokens.mockImplementationOnce(async ({ deleteToken }) => {
          await deleteToken({ userId, type: 'mcp_oauth', identifier: `mcp:${serverName}` });
        });
        await deleteStoredTokens(session);
        committed = true;
      });
      const result = maybeUninstallOAuthMCP(userId, pluginKey, appConfig, commit);
      if (failCommit) {
        await expect(result).rejects.toThrow('audit unavailable');
        expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
        expect(mockDeleteUserTokens).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toBeUndefined();
        expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(2);
        expect(mockDeleteTokens).toHaveBeenCalledWith(expect.objectContaining({ userId }), session);
      }
    },
  );

  test.each(['tokens', 'flow'])(
    'does not report governed revocation success when %s cleanup fails',
    async (failure) => {
      const previous = process.env.GOVERNANCE_PILOT_ENABLED;
      process.env.GOVERNANCE_PILOT_ENABLED = 'true';
      setupOAuthServerFound();
      mockGetTokens.mockResolvedValue(null);
      mockDeleteUserTokens.mockResolvedValue(undefined);
      mockDeleteFlow.mockResolvedValue(undefined);
      if (failure === 'tokens')
        mockDeleteUserTokens.mockRejectedValueOnce(new Error('token failure containing secret'));
      else mockDeleteFlow.mockRejectedValueOnce(new Error('flow failure containing secret'));
      try {
        await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).rejects.toThrow(
          'Failed to clear MCP OAuth authorization',
        );
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('containing secret');
      } finally {
        if (previous === undefined) delete process.env.GOVERNANCE_PILOT_ENABLED;
        else process.env.GOVERNANCE_PILOT_ENABLED = previous;
        mockDeleteUserTokens.mockResolvedValue(undefined);
        mockDeleteFlow.mockResolvedValue(undefined);
      }
    },
  );

  test('does not commit governed revocation when the flow cache cannot delete authorization', async () => {
    const previous = process.env.GOVERNANCE_PILOT_ENABLED;
    process.env.GOVERNANCE_PILOT_ENABLED = 'true';
    const { Keyv } = require('keyv');
    const { FlowStateManager } = jest.requireActual('@librechat/api');
    const store = new Keyv();
    const flowManager = new FlowStateManager(store, { ttl: 180000, ci: true });
    const tokens = { access_token: 'cached-access-token' };
    const flowId = `${userId}:${serverName}`;
    await flowManager.initFlow(flowId, 'mcp_get_tokens', {});
    await flowManager.completeFlow(flowId, 'mcp_get_tokens', tokens);
    const deletion = jest.spyOn(store, 'delete').mockRejectedValue(new Error('cache unavailable'));
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue(tokens);
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockImplementation((...args) => flowManager.deleteFlow(...args));
    mockRevokeOAuthToken.mockRejectedValue(new Error('provider unavailable'));
    const commit = jest.fn(async (deleteStoredTokens) => deleteStoredTokens());

    try {
      await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig, commit)).rejects.toThrow(
        'Failed to clear MCP OAuth authorization',
      );
      expect(deletion).toHaveBeenCalled();
      expect(mockDeleteFlow).toHaveBeenCalledWith(flowId, 'mcp_get_tokens');
      expect(commit).not.toHaveBeenCalled();
      expect(mockDeleteUserTokens).not.toHaveBeenCalled();
      expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
      expect(await flowManager.getFlowState(flowId, 'mcp_get_tokens')).toMatchObject({
        status: 'COMPLETED',
        result: tokens,
      });
    } finally {
      deletion.mockRestore();
      await store.clear();
      if (previous === undefined) delete process.env.GOVERNANCE_PILOT_ENABLED;
      else process.env.GOVERNANCE_PILOT_ENABLED = previous;
      mockDeleteFlow.mockResolvedValue(undefined);
      mockRevokeOAuthToken.mockResolvedValue(undefined);
    }
  });

  test('preserves non-governed cleanup when flow deletion returns false', async () => {
    const previous = process.env.GOVERNANCE_PILOT_ENABLED;
    process.env.GOVERNANCE_PILOT_ENABLED = 'false';
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({ access_token: 'cached-access-token' });
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(false);
    mockRevokeOAuthToken.mockRejectedValue(new Error('provider unavailable'));

    try {
      await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).resolves.toBeUndefined();
      expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(1);
      expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
      expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env.GOVERNANCE_PILOT_ENABLED;
      else process.env.GOVERNANCE_PILOT_ENABLED = previous;
      mockDeleteFlow.mockResolvedValue(undefined);
      mockRevokeOAuthToken.mockResolvedValue(undefined);
    }
  });

  test('is a no-op when pluginKey is not an MCP key', async () => {
    await maybeUninstallOAuthMCP(userId, 'plugin_google_calendar', appConfig);

    expect(mockGetServerConfig).not.toHaveBeenCalled();
    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).not.toHaveBeenCalled();
    expect(mockDeleteFlow).not.toHaveBeenCalled();
  });

  test('clears stored state when the MCP server is not an OAuth server', async () => {
    mockGetServerConfig.mockResolvedValue(serverConfig);
    mockGetOAuthServers.mockResolvedValue(new Set(['other']));

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockGetClientInfoAndMetadata).not.toHaveBeenCalled();
    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });
    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
  });

  test('clears stored state when client info is missing', async () => {
    setupOAuthServerFound();
    mockGetClientInfoAndMetadata.mockResolvedValue(null);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });
    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
  });

  test('clears stored state when client info cannot be loaded', async () => {
    setupOAuthServerFound();
    mockGetClientInfoAndMetadata.mockRejectedValue(new Error('bad client data'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });
    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `[maybeUninstallOAuthMCP] Unable to load OAuth client metadata for ${serverName}; clearing local MCP OAuth state only.`,
      expect.any(Error),
    );
  });

  test('clears tenant-scoped and legacy flow state when tenant context exists', async () => {
    setupOAuthServerFound();
    mockGetTenantId.mockReturnValue('tenant-a');
    mockGetClientInfoAndMetadata.mockResolvedValue(null);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockDeleteFlow).toHaveBeenCalledTimes(4);
    expect(mockDeleteFlow).toHaveBeenCalledWith('tenant:tenant-a:user-123:acme', 'mcp_get_tokens');
    expect(mockDeleteFlow).toHaveBeenCalledWith('tenant:tenant-a:user-123:acme', 'mcp_oauth');
    expect(mockDeleteFlow).toHaveBeenCalledWith('user-123:acme', 'mcp_get_tokens');
    expect(mockDeleteFlow).toHaveBeenCalledWith('user-123:acme', 'mcp_oauth');
  });

  test('revokes both tokens and runs cleanup on happy path', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({
      access_token: 'access-abc',
      refresh_token: 'refresh-xyz',
    });
    mockRevokeOAuthToken.mockResolvedValue(undefined);
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(2);
    expect(mockRevokeOAuthToken.mock.calls[0][1]).toBe('access-abc');
    expect(mockRevokeOAuthToken.mock.calls[0][2]).toBe('access');
    expect(mockRevokeOAuthToken.mock.calls[1][1]).toBe('refresh-xyz');
    expect(mockRevokeOAuthToken.mock.calls[1][2]).toBe('refresh');

    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });

    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
    expect(mockDeleteFlow.mock.calls[0][1]).toBe('mcp_get_tokens');
    expect(mockDeleteFlow.mock.calls[1][1]).toBe('mcp_oauth');
  });

  test('skips revocation but still runs cleanup when token retrieval fails', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockRejectedValue(new Error('missing'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).resolves.toBeUndefined();

    expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `[maybeUninstallOAuthMCP] Unable to load OAuth tokens for ${serverName}; clearing local token state.`,
      expect.any(Error),
    );
  });

  test('skips revocation, logs warn, and still runs cleanup on unexpected token-retrieval error', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockRejectedValue(new Error('boom: unreachable'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).resolves.toBeUndefined();

    expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `[maybeUninstallOAuthMCP] Unable to load OAuth tokens for ${serverName}; clearing local token state.`,
      expect.any(Error),
    );
  });

  test('continues cleanup when only one token type is present', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({ access_token: 'only-access' });
    mockRevokeOAuthToken.mockResolvedValue(undefined);
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeOAuthToken.mock.calls[0][2]).toBe('access');
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
  });

  test('still runs cleanup even when both revocation calls fail', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
    });
    mockRevokeOAuthToken.mockRejectedValue(new Error('network down'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).resolves.toBeUndefined();

    expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(2);
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
