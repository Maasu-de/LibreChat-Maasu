import React from 'react';
import { act, renderHook } from '@testing-library/react';
import type { MCPServerDefinition } from '~/hooks';
import { MCPAdministrationContext } from '../../../administration';
import { AuthTypeEnum, useMCPServerForm } from '../useMCPServerForm';

const mockCreate = jest.fn().mockResolvedValue({ serverName: 'remote' });
const mockUpdate = jest.fn().mockResolvedValue({ serverName: 'remote' });
const mockShowToast = jest.fn();

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockShowToast }) }));
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
  it.each(['create', 'update'])(
    'keeps rejected %s input open and shows safe configuration guidance',
    async (operation) => {
      const isEditMode = operation === 'update';
      const server: MCPServerDefinition | undefined = isEditMode
        ? {
            serverName: 'remote',
            effectivePermissions: 7,
            config: { type: 'sse', url: 'https://remote.example/mcp' },
          }
        : undefined;
      const onSuccess = jest.fn();
      const onClose = jest.fn();
      const mutation = isEditMode ? mockUpdate : mockCreate;
      mutation.mockRejectedValueOnce({
        response: {
          data: {
            error: 'MCP_INVALID_ADMIN_CONNECTION',
            message: 'Provider rejected https://remote.example/mcp?api_token=private-secret',
          },
        },
      });
      const { result } = renderHook(() => useMCPServerForm({ server, onSuccess, onClose }), {
        wrapper: Wrapper,
      });
      const url = 'https://remote.example/mcp?api_token=private-secret';
      act(() => result.current.methods.setValue('url', url));

      await act(async () => result.current.onSubmit());

      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_mcp_invalid_admin_connection',
        status: 'error',
      });
      expect(JSON.stringify(mockShowToast.mock.calls)).not.toContain('private-secret');
      expect(result.current.methods.getValues('url')).toBe(url);
      expect(result.current.isSubmitting).toBe(false);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it('creates an unauthenticated connection without adding credentials', async () => {
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useMCPServerForm({ onSuccess }), { wrapper: Wrapper });
    act(() => result.current.methods.setValue('url', 'https://remote.example/mcp?tenant=acme'));

    await act(async () => result.current.onSubmit());

    expect(mockCreate).toHaveBeenCalledWith({
      config: {
        type: 'streamable-http',
        title: 'Remote',
        url: 'https://remote.example/mcp?tenant=acme',
      },
    });
    expect(onSuccess).toHaveBeenCalledWith('remote', false);
  });

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
