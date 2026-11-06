import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, getTagByKey } from 'librechat-data-provider';
import type {
  TMessage,
  TConversation,
  TUpdateFeedbackRequest,
  TUpdateFeedbackResponse,
} from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common/types';
import useMessageActions from '~/hooks/Messages/useMessageActions';

const mockUpdateFeedback = jest.fn<Promise<TUpdateFeedbackResponse>, [TUpdateFeedbackRequest]>();

jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateFeedbackMutation: () =>
    jest.requireActual('@tanstack/react-query').useMutation(mockUpdateFeedback),
}));
jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => undefined,
  useAssistantsMapContext: () => undefined,
}));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: undefined }) }));
jest.mock('~/hooks/Chat', () => ({ useGetAddedConvo: () => () => null }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const conversation = { conversationId: 'conversation-1', endpoint: 'agents' } as TConversation;
const message = {
  messageId: 'message-1',
  conversationId: conversation.conversationId,
  isCreatedByUser: false,
  text: '',
} as TMessage;
const feedback = { rating: 'thumbsUp' as const, tag: getTagByKey('accurate_reliable') };

function deferred() {
  let resolve: (value: TUpdateFeedbackResponse) => void = () => undefined;
  const promise = new Promise<TUpdateFeedbackResponse>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useMessageActions handleParallelFeedback', () => {
  it('caches every comparison rating when both requests are in flight', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [message],
    );

    const first = deferred();
    const second = deferred();
    mockUpdateFeedback.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>{children}</RecoilRoot>
      </QueryClientProvider>
    );
    const chatContext = { conversation, index: 0 } as unknown as TMessageChatContext;
    const { result } = renderHook(() => useMessageActions({ message, chatContext }), { wrapper });

    act(() => {
      result.current.handleParallelFeedback('agent-a', feedback);
      result.current.handleParallelFeedback('agent-b', feedback);
    });
    await waitFor(() => expect(mockUpdateFeedback).toHaveBeenCalledTimes(2));

    const response = (agentId: string): TUpdateFeedbackResponse => ({
      agentId,
      messageId: message.messageId,
      conversationId: conversation.conversationId ?? '',
      feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' },
    });
    await act(async () => {
      first.resolve(response('agent-a'));
      second.resolve(response('agent-b'));
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<TMessage[]>([
        QueryKeys.messages,
        conversation.conversationId,
      ]);
      expect(cached?.[0].parallelFeedback?.map((entry) => entry.agentId).sort()).toEqual([
        'agent-a',
        'agent-b',
      ]);
    });
  });
});
