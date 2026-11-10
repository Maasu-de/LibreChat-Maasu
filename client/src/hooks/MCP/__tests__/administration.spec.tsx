import React from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMCPSelect } from '~/hooks';
import { useMCPServersQuery } from '~/data-provider';
import { MCPAdministrationContext } from '~/components/SidePanel/MCPBuilder/administration';
import { useMCPServerManager } from '../useMCPServerManager';

let mockStartupConfig: { governancePilotEnabled: boolean } | undefined;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useMCPSelect: jest.fn(() => ({ mcpValues: [], setMCPValues: jest.fn() })),
  useMCPConnectionStatus: () => ({ connectionStatus: {} }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
  useMCPServersQuery: jest.fn(() => ({
    data: { remote: { dbId: 'id', type: 'sse', url: 'https://remote.example/mcp' } },
    isLoading: false,
  })),
}));

jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('librechat-data-provider/react-query', () => ({
  useCancelMCPOAuthMutation: () => ({}),
  useUpdateUserPluginsMutation: () => ({}),
  useReinitializeMCPServerMutation: () => ({}),
  useGetAllEffectivePermissionsQuery: () => ({ data: {} }),
}));

function wrapper(administration: boolean) {
  const queryClient = new QueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MCPAdministrationContext.Provider value={administration}>
          {children}
        </MCPAdministrationContext.Provider>
      </QueryClientProvider>
    );
  };
}

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
});
