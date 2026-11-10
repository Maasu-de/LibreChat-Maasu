import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';
import MCPInspection from '../MCPInspection';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => {
  const original = jest.requireActual('librechat-data-provider');
  return {
    ...original,
    dataService: { ...original.dataService, inspectMCPServer: jest.fn() },
  };
});

function renderInspection() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MCPInspection serverName="remote" />
    </QueryClientProvider>,
  );
}

describe('MCP connection inspection', () => {
  it('discovers tools only on request and shows their descriptions and schemas', async () => {
    jest.mocked(dataService.inspectMCPServer).mockResolvedValue({
      success: true,
      tools: [{ name: 'lookup', description: 'Search records', inputSchema: { type: 'object' } }],
    });
    renderInspection();
    expect(dataService.inspectMCPServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_mcp_inspect' }));
    expect(await screen.findByText('lookup')).toBeInTheDocument();
    expect(screen.getByText('Search records')).toBeInTheDocument();
    expect(screen.getByText(/"type": "object"/)).toBeInTheDocument();
    expect(dataService.inspectMCPServer).toHaveBeenCalledWith('remote');
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_mcp_inspection_success');
  });

  it('reports inspection failure without exposing the server error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(dataService.inspectMCPServer).mockRejectedValue(new Error('private server error'));
    renderInspection();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_mcp_inspect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_mcp_server_connection_failed',
    );
    expect(screen.queryByText('private server error')).not.toBeInTheDocument();
  });
});
