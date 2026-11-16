import { act, renderHook } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EModelEndpoint,
  EToolResources,
  GOVERNANCE_ENDPOINT,
  QueryKeys,
} from 'librechat-data-provider';
import type { DropTargetHookSpec, DropTargetMonitor } from 'react-dnd';
import type { TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { startupConfigKey } from '~/data-provider';
import store from '~/store';
import useDragHelpers from '../useDragHelpers';

const mockHandleFiles = jest.fn();
const mockShowToast = jest.fn();
let mockDrop: DropTargetHookSpec<{ files: File[] }, void, object>['drop'];

jest.mock('react-dnd', () => ({
  useDrop: (createSpec: () => DropTargetHookSpec<{ files: File[] }, void, object>) => {
    mockDrop = createSpec().drop;
    return [{ canDrop: true, isOver: false }, jest.fn()];
  },
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('../useFileHandling', () => ({
  __esModule: true,
  default: () => ({ handleFiles: mockHandleFiles }),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

function renderDrop(endpoint: string, disabled = false) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(startupConfigKey(true), { governancePilotEnabled: true });
  queryClient.setQueryData([QueryKeys.endpoints], {
    [GOVERNANCE_ENDPOINT]: { type: EModelEndpoint.custom },
    [EModelEndpoint.agents]: { capabilities: [] },
  });
  queryClient.setQueryData([QueryKeys.fileConfig], {
    endpoints: {
      default: { disabled: true },
      [GOVERNANCE_ENDPOINT]: { disabled },
      [EModelEndpoint.agents]: { disabled },
    },
  });
  const conversation = {
    endpoint,
    conversationId: 'conversation',
    ...(endpoint === EModelEndpoint.agents ? { agent_id: 'agent_saved' } : {}),
  } as TConversation;
  return renderHook(() => useDragHelpers(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot initializeState={({ set }) => set(store.conversationByIndex(0), conversation)}>
          {children}
        </RecoilRoot>
      </QueryClientProvider>
    ),
  });
}

beforeEach(() => jest.clearAllMocks());

it.each([GOVERNANCE_ENDPOINT, EModelEndpoint.agents])(
  'routes governed text drops through the text context option in %s',
  (endpoint) => {
    const file = new File(['Agenda'], 'agenda.txt', { type: 'text/plain' });
    const { result } = renderDrop(endpoint);

    act(() => mockDrop?.({ files: [file] }, {} as DropTargetMonitor));

    expect(result.current.showModal).toBe(true);
    expect(mockHandleFiles).not.toHaveBeenCalled();
    act(() => result.current.handleOptionSelect(EToolResources.context));
    expect(mockHandleFiles).toHaveBeenCalledWith([file], EToolResources.context);
    expect(result.current.showModal).toBe(false);
  },
);

it.each([GOVERNANCE_ENDPOINT, EModelEndpoint.agents])(
  'continues to block disabled uploads for %s',
  (endpoint) => {
    const { result } = renderDrop(endpoint, true);

    act(() => mockDrop?.({ files: [new File(['Agenda'], 'agenda.txt')] }, {} as DropTargetMonitor));

    expect(result.current.showModal).toBe(false);
    expect(mockHandleFiles).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', message: 'com_ui_attach_error_disabled' }),
    );
  },
);
