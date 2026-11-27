import React from 'react';
import { Provider } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionBits, QueryKeys } from 'librechat-data-provider';
import type { MCPServersListResponse } from 'librechat-data-provider';
import { useMCPSelect } from '~/hooks';
import { useMCPServersQuery } from '~/data-provider';
import { MCPAdministrationContext } from '~/components/SidePanel/MCPBuilder/administration';
import { useMCPServerManager } from '../useMCPServerManager';

let mockStartupConfig: { governancePilotEnabled: boolean } | undefined;
let mockServers: MCPServersListResponse;
const mockShowToast = jest.fn();
const mockReinitialize = jest.fn();
const mockGetOAuthStatus = jest.fn();

jest.mock('librechat-data-provider', () => {
  const original = jest.requireActual('librechat-data-provider');
  return {
    ...original,
    dataService: {
      ...original.dataService,
      getMCPOAuthStatus: (...args: unknown[]) => mockGetOAuthStatus(...args),
    },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useMCPSelect: jest.fn(() => ({ mcpValues: [], setMCPValues: jest.fn() })),
  useMCPConnectionStatus: () => ({ connectionStatus: {} }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
  useMCPServersQuery: jest.fn(() => ({
    data: mockServers,
    isLoading: false,
  })),
}));

jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockShowToast }) }));
jest.mock('librechat-data-provider/react-query', () => ({
  useCancelMCPOAuthMutation: () => ({}),
  useUpdateUserPluginsMutation: () => ({}),
  useReinitializeMCPServerMutation: () => ({ mutateAsync: mockReinitialize }),
  useGetAllEffectivePermissionsQuery: () => ({ data: {} }),
}));

function wrapper(administration: boolean, queryClient = new QueryClient()) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Provider>
          <MCPAdministrationContext.Provider value={administration}>
            {children}
          </MCPAdministrationContext.Provider>
        </Provider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  mockServers = {
    remote: {
      serverName: 'remote',
      dbId: 'id',
      type: 'sse',
      url: 'https://remote.example/mcp',
    },
  };
});

describe('governed MCP management isolation', () => {
  beforeEach(() => {
    mockStartupConfig = { governancePilotEnabled: true };
  });

  it('waits for startup restrictions before exposing cached servers to chat', () => {
    mockStartupConfig = undefined;
    const { result } = renderHook(() => useMCPServerManager(), { wrapper: wrapper(false) });
    expect(useMCPServersQuery).toHaveBeenCalledWith({ enabled: false });
    expect(result.current.availableMCPServers).toEqual([]);
    expect(useMCPSelect).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
  it('keeps cached administrative connections out of governed chat and agents', () => {
    const { result } = renderHook(() => useMCPServerManager(), { wrapper: wrapper(false) });
    expect(useMCPServersQuery).toHaveBeenCalledWith({ enabled: false });
    expect(result.current.availableMCPServers).toEqual([]);
    expect(result.current.availableMCPServersMap).toBeUndefined();
    expect(result.current.selectableServers).toEqual([]);
    expect(useMCPSelect).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('loads connections for administration without changing chat selection', () => {
    const { result } = renderHook(() => useMCPServerManager(), { wrapper: wrapper(true) });
    expect(useMCPServersQuery).toHaveBeenCalledWith({ enabled: true });
    expect(result.current.availableMCPServers.map((server) => server.serverName)).toEqual([
      'remote',
    ]);
    expect(useMCPSelect).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it.each([true, false])(
    'filters unsupported administration cards without changing ordinary MCP views: administration=%s',
    (administration) => {
      mockStartupConfig = { governancePilotEnabled: false };
      mockServers = {
        ...mockServers,
        streamable: {
          serverName: 'streamable',
          dbId: 'streamable-id',
          type: 'streamable-http',
          url: 'https://streamable.example/mcp',
        },
        http: {
          serverName: 'http',
          dbId: 'http-id',
          type: 'http',
          url: 'https://http.example/mcp',
        },
        configuredRemote: {
          serverName: 'configuredRemote',
          type: 'sse',
          url: 'https://configured.example/mcp',
        },
        configuredLocal: {
          serverName: 'configuredLocal',
          type: 'stdio',
          command: 'configured-command',
          args: [],
        },
        persistedLocal: {
          serverName: 'persistedLocal',
          dbId: 'local-id',
          type: 'stdio',
          command: 'local-command',
          args: [],
        },
      };

      const { result } = renderHook(() => useMCPServerManager(), {
        wrapper: wrapper(administration),
      });

      expect(result.current.availableMCPServers.map((server) => server.serverName)).toEqual(
        administration ? ['remote', 'streamable', 'http'] : Object.keys(mockServers),
      );
      expect(
        result.current.availableMCPServers.map((server) => server.effectivePermissions),
      ).toEqual(
        administration
          ? Array(3).fill(PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE)
          : Array(6).fill(PermissionBits.VIEW),
      );
    },
  );
});

describe('OAuth authorization completion polling', () => {
  const oauthAttempt = { flowId: 'flow-id', id: 'current-attempt' };

  beforeEach(() => {
    jest.useFakeTimers();
    mockStartupConfig = { governancePilotEnabled: false };
    mockReinitialize.mockResolvedValue({
      success: true,
      oauthRequired: true,
      oauthUrl: 'https://identity.example/authorize',
      oauthAttempt,
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each(['connected', 'disconnected'] as const)(
    'waits for the current attempt even when the old grant reports %s',
    async (connectionState) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData([QueryKeys.mcpConnectionStatus], {
        connectionStatus: {
          remote: {
            connectionState,
            requiresOAuth: true,
            authorizationComplete: true,
          },
        },
      });
      jest.spyOn(queryClient, 'refetchQueries').mockResolvedValue(undefined);
      mockGetOAuthStatus
        .mockResolvedValueOnce({ attemptId: oauthAttempt.id, completed: false, failed: false })
        .mockResolvedValueOnce({ attemptId: oauthAttempt.id, completed: true, failed: false });
      const { result, unmount } = renderHook(() => useMCPServerManager(), {
        wrapper: wrapper(true, queryClient),
      });

      await act(async () => {
        await result.current.initializeServer('remote', false);
      });
      expect(result.current.isInitializing('remote')).toBe(true);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });

      expect(mockGetOAuthStatus).toHaveBeenCalledWith(oauthAttempt.flowId);
      expect(result.current.isInitializing('remote')).toBe(true);
      expect(mockShowToast).not.toHaveBeenCalled();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(6000);
      });
      expect(result.current.isInitializing('remote')).toBe(false);
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_mcp_authenticated_success',
        status: 'success',
      });
      unmount();
      queryClient.clear();
    },
  );

  it.each([
    { attemptId: 'another-attempt', completed: true, failed: false },
    { attemptId: oauthAttempt.id, completed: false, failed: true },
  ])('does not accept a failed or replaced attempt (%j)', async (status) => {
    mockGetOAuthStatus.mockResolvedValueOnce(status);
    const { result } = renderHook(() => useMCPServerManager(), { wrapper: wrapper(true) });
    await act(async () => {
      await result.current.initializeServer('remote', false);
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.isInitializing('remote')).toBe(false);
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_mcp_init_failed',
      status: 'error',
    });
  });

  it('keeps ordinary chat polling on the connection-status API', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.mcpConnectionStatus], {
      connectionStatus: { remote: { connectionState: 'connected', requiresOAuth: true } },
    });
    jest.spyOn(queryClient, 'refetchQueries').mockResolvedValue(undefined);
    const { result } = renderHook(() => useMCPServerManager(), {
      wrapper: wrapper(false, queryClient),
    });
    await act(async () => {
      await result.current.initializeServer('remote', false);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.isInitializing('remote')).toBe(false);
    expect(mockGetOAuthStatus).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_mcp_authenticated_success',
      status: 'success',
    });
    queryClient.clear();
  });
});
