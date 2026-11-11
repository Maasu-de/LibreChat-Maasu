import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';
import type { MCPInspectionResponse } from 'librechat-data-provider';
import type { MCPServerDefinition } from '~/hooks';
import { useUpdateMCPServerMutation } from '~/data-provider/MCP/mutations';
import { useMCPServersQuery } from '~/data-provider/MCP/queries';
import { MCPAdministrationContext } from '../administration';
import MCPServerList from '../MCPServerList';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useMCPServerManager: () => ({
    initializeServer: jest.fn(),
    revokeOAuthForServer: jest.fn(),
  }),
}));
jest.mock('../MCPServerDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('../MCPCardActions', () => ({ __esModule: true, default: () => null }));
jest.mock('librechat-data-provider', () => {
  const original = jest.requireActual('librechat-data-provider');
  return {
    ...original,
    dataService: {
      ...original.dataService,
      getMCPServers: jest.fn(),
      inspectMCPServer: jest.fn(),
      updateMCPServer: jest.fn(),
    },
  };
});

const initialConfig: MCPServerDefinition['config'] = {
  type: 'sse',
  url: 'https://original.example/mcp',
  updatedAt: 1,
};

const inspectionResult: MCPInspectionResponse = {
  success: true,
  tools: [{ name: 'original_tool', inputSchema: { type: 'object' } }],
};
const saveLabel = 'Save connection';

function renderManagement(editedConfig: MCPServerDefinition['config'], initial = initialConfig) {
  let persistedServer = { ...initial, serverName: 'remote', dbId: 'connection-id' };
  jest.mocked(dataService.getMCPServers).mockImplementation(async () => ({
    remote: persistedServer,
  }));
  jest.mocked(dataService.updateMCPServer).mockImplementation(async () => {
    persistedServer = { ...editedConfig, serverName: 'remote', dbId: 'connection-id' };
    return persistedServer;
  });

  function Management() {
    const { data } = useMCPServersQuery();
    const update = useUpdateMCPServerMutation();
    const servers = Object.entries(data ?? {}).map(([serverName, { dbId, ...config }]) => ({
      serverName,
      dbId,
      config,
      effectivePermissions: 7,
    }));

    return (
      <>
        <button
          onClick={() =>
            update.mutate({
              serverName: 'remote',
              data: { config: { type: 'sse', url: 'https://edited.example/mcp' } },
            })
          }
        >
          {saveLabel}
        </button>
        <MCPServerList
          servers={servers}
          getServerStatusIconProps={(serverName) => ({
            serverName,
            isInitializing: false,
            canCancel: false,
            onConfigClick: jest.fn(),
            onCancel: jest.fn(),
          })}
        />
      </>
    );
  }

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MCPAdministrationContext.Provider value={true}>
        <Management />
      </MCPAdministrationContext.Provider>
    </QueryClientProvider>,
  );
}

describe('inspection after editing an administrative MCP connection', () => {
  it.each([
    ['endpoint', { ...initialConfig, url: 'https://edited.example/mcp', updatedAt: 2 }],
    ['transport', { ...initialConfig, type: 'streamable-http' as const, updatedAt: 2 }],
    ['authentication', { ...initialConfig, oauth: {}, updatedAt: 2 }],
    ['stored secret', { ...initialConfig, updatedAt: 2 }],
  ])('clears previous inspection results after a persisted %s edit', async (_field, edited) => {
    jest.mocked(dataService.inspectMCPServer).mockResolvedValue(inspectionResult);
    renderManagement(edited);
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_mcp_inspect' }));
    expect(await screen.findByText('original_tool')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: saveLabel }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByText('original_tool')).not.toBeInTheDocument();
    expect(dataService.inspectMCPServer).toHaveBeenCalledTimes(1);

    jest.mocked(dataService.inspectMCPServer).mockResolvedValue({ success: true, tools: [] });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_mcp_inspect' }));
    expect(await screen.findByText('com_ui_mcp_no_tools')).toBeInTheDocument();
    expect(dataService.inspectMCPServer).toHaveBeenCalledTimes(2);
  });

  it('ignores an inspection that completes after its connection was edited', async () => {
    let completeInspection!: (result: MCPInspectionResponse) => void;
    jest.mocked(dataService.inspectMCPServer).mockReturnValue(
      new Promise((resolve) => {
        completeInspection = resolve;
      }),
    );
    renderManagement({ ...initialConfig, updatedAt: 2 });
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_mcp_inspect' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'com_ui_mcp_inspect' })).toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: saveLabel }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'com_ui_mcp_inspect' })).toBeEnabled(),
    );
    await act(async () => completeInspection(inspectionResult));
    expect(screen.queryByText('original_tool')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(dataService.inspectMCPServer).toHaveBeenCalledTimes(1);
  });
});
