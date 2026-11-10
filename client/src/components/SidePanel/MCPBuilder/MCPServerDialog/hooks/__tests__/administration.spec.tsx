import React from 'react';
import { act, renderHook } from '@testing-library/react';
import type { MCPServerDefinition } from '~/hooks';
import { MCPAdministrationContext } from '../../../administration';
import { AuthTypeEnum, useMCPServerForm } from '../useMCPServerForm';

const mockCreate = jest.fn().mockResolvedValue({ serverName: 'remote' });
const mockUpdate = jest.fn().mockResolvedValue({ serverName: 'remote' });

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('~/data-provider/MCP', () => ({
  useCreateMCPServerMutation: () => ({ mutateAsync: mockCreate }),
  useUpdateMCPServerMutation: () => ({ mutateAsync: mockUpdate }),
  useDeleteMCPServerMutation: () => ({ mutateAsync: jest.fn() }),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MCPAdministrationContext.Provider value={true}>{children}</MCPAdministrationContext.Provider>
  );
}

describe('administrative MCP connection form', () => {
  it('uses administrator-provided service credentials only', async () => {
    const { result } = renderHook(() => useMCPServerForm({}), { wrapper: Wrapper });
    act(() => {
      result.current.methods.setValue('url', 'https://remote.example/mcp');
      result.current.methods.setValue('auth.auth_type', AuthTypeEnum.ServiceHttp);
      result.current.methods.setValue('auth.api_key_source', 'user');
      result.current.methods.setValue('auth.api_key', 'service-secret');
    });
    await act(async () => result.current.onSubmit());
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          apiKey: {
            source: 'admin',
            authorization_type: 'bearer',
            key: 'service-secret',
          },
        }),
      }),
    );
  });

  it('keeps OAuth selected when using discovery without a supplied client registration', async () => {
    const { result } = renderHook(() => useMCPServerForm({}), { wrapper: Wrapper });
    act(() => result.current.methods.setValue('auth.auth_type', AuthTypeEnum.OAuth));
    await act(async () => result.current.onSubmit());
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ oauth: {} }),
      }),
    );
  });

  it('never prefills service credentials or OAuth client secrets', () => {
    const server: MCPServerDefinition = {
      serverName: 'remote',
      effectivePermissions: 7,
      config: {
        type: 'sse',
        url: 'https://remote.example/mcp',
        apiKey: { source: 'admin', key: 'stored-service-secret', authorization_type: 'bearer' },
        oauth: { client_secret: 'stored-oauth-secret' },
      },
    };
    const { result } = renderHook(() => useMCPServerForm({ server }), { wrapper: Wrapper });
    expect(result.current.methods.getValues('auth.api_key')).toBe('');
    expect(result.current.methods.getValues('auth.oauth_client_secret')).toBe('');
  });
});
