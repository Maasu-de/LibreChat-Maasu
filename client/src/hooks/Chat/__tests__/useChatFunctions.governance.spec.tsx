import React, { useState } from 'react';
import axios from 'axios';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ContentTypes,
  EModelEndpoint,
  QueryKeys,
  encodeEphemeralAgentId,
} from 'librechat-data-provider';
import type {
  TMessage,
  TSubmission,
  TConversation,
  GovernanceDlpCheckRequest,
  GovernanceDlpCheckResponse,
} from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import DlpInterventionDialog from '~/components/Chat/Input/DlpInterventionDialog';
import useEventHandlers from '~/hooks/SSE/useEventHandlers';
import useChatFunctions from '../useChatFunctions';

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGovernanceDlpCheckMutation: jest.requireActual('~/data-provider/Governance/mutations')
    .useGovernanceDlpCheckMutation,
}));

jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => jest.fn());
jest.mock('~/hooks/Conversations/useGetSender', () => () => () => 'AI');
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: () => undefined }));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: { log: jest.fn(), dir: jest.fn() },
  cn: jest.requireActual('~/utils/cn').default,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' }, token: 'test-token' }),
}));
jest.mock('~/hooks/Agents', () => ({ useApplyAgentTemplate: () => jest.fn() }));
jest.mock('~/Providers', () => ({ useLiveAnnouncer: () => ({ announcePolite: jest.fn() }) }));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

const endpoint = 'AI Governance Gateway' as EModelEndpoint;
const model = 'governed-model';
const iban = 'My IBAN is GB82 WEST 1234 5698 7654 32';
const newConversation: TConversation = {
  conversationId: null,
  title: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  endpoint,
  model,
};
const savedConversation: TConversation = {
  ...newConversation,
  conversationId: 'conversation-1',
  agent_id: encodeEphemeralAgentId({ endpoint, model }),
};

const setSubmission = jest.fn<void, Parameters<SetterOrUpdater<TSubmission | null>>>();
const setMessages = jest.fn<void, [TMessage[]]>();

function Chat({
  conversation,
  history = [],
}: {
  conversation: TConversation;
  history?: TMessage[];
}) {
  const [text, setText] = useState('');
  const { ask, pendingDlpSubmission, cancelDlpIntervention, confirmDlpIntervention } =
    useChatFunctions({
      conversation,
      getMessages: () => history,
      setMessages,
      setSubmission,
      isSubmitting: false,
      latestMessage: history.at(-1) ?? null,
    });

  return (
    <>
      <input aria-label="Prompt" value={text} onChange={(event) => setText(event.target.value)} />
      <button aria-label="Send" onClick={() => ask({ text })} />
      {pendingDlpSubmission && (
        <DlpInterventionDialog
          result={pendingDlpSubmission.result}
          originalText={pendingDlpSubmission.props.text}
          onCancel={cancelDlpIntervention}
          onConfirm={confirmDlpIntervention}
        />
      )}
    </>
  );
}

function renderChat(conversation: TConversation) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData([QueryKeys.startupConfig], { governanceDlpEnabled: true });
  queryClient.setQueryData([QueryKeys.endpoints], { [endpoint]: { type: EModelEndpoint.custom } });
  const view = render(<Chat conversation={conversation} />, {
    wrapper: ({ children }) => (
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <QueryClientProvider client={queryClient}>
          <RecoilRoot>{children}</RecoilRoot>
        </QueryClientProvider>
      </MemoryRouter>
    ),
  });
  return { ...view, queryClient };
}

function send(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => {
  setSubmission.mockClear();
  setMessages.mockClear();
  jest.spyOn(axios, 'post').mockImplementation(async (url, data) => {
    if (url !== '/api/governance/dlp/check' || typeof data !== 'string') {
      throw new Error('Unexpected HTTP request in DLP fixture');
    }
    const { text }: GovernanceDlpCheckRequest = JSON.parse(data);
    const response: GovernanceDlpCheckResponse = {
      enabled: true,
      decision: text === iban ? 'BLOCK' : 'ALLOW',
      policyVersion: 1,
      findings:
        text === iban
          ? [
              {
                location: '/messages/0/content',
                start: 11,
                end: 38,
                category: 'IBAN_CODE',
                action: 'BLOCK',
              },
            ]
          : [],
    };
    return { data: response };
  });
});

it.each([newConversation, savedConversation])(
  'shows a blocking dialog without submitting in conversation $conversationId',
  async (conversation) => {
    const { queryClient } = renderChat(conversation);

    send(iban);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('com_ui_dlp_block_title')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_continue')).not.toBeInTheDocument();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    queryClient.clear();
  },
);

it('keeps checking after hi, permits repeated clean follow-ups and blocks a later IBAN', async () => {
  const { rerender, queryClient } = renderChat(newConversation);
  send('hi');
  await waitFor(() => expect(setSubmission).toHaveBeenCalledTimes(1));

  const history = setMessages.mock.calls[0][0].map((message) => ({
    ...message,
    conversationId: savedConversation.conversationId,
    text: message.isCreatedByUser ? message.text : 'Hello',
  }));
  rerender(<Chat conversation={savedConversation} history={history} />);
  send(iban);
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(setSubmission).toHaveBeenCalledTimes(1);
  expect(setMessages).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));

  for (const [index, prompt] of ['Tell me about rain', 'Tell me more'].entries()) {
    send(prompt);
    await waitFor(() => expect(setSubmission).toHaveBeenCalledTimes(index + 2));
    const submission = setSubmission.mock.calls[index + 1][0];
    if (submission == null || typeof submission === 'function') {
      throw new Error('Expected a chat submission');
    }
    expect(submission.conversation.conversationId).toBe(savedConversation.conversationId);
    expect(submission.userMessage.text).toBe(prompt);
    expect(submission.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: iban })]),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const completedHistory = setMessages.mock.calls.at(-1)![0].map((message) => ({
      ...message,
      text: message.isCreatedByUser ? message.text : 'OK',
    }));
    rerender(<Chat conversation={savedConversation} history={completedHistory} />);
  }

  send(iban);
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledTimes(5);
  expect(setSubmission).toHaveBeenCalledTimes(3);
  expect(setMessages).toHaveBeenCalledTimes(3);
  queryClient.clear();
});

it('characterization: completion error retains the user message and the follow-up parent chain', async () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData([QueryKeys.startupConfig], { governanceDlpEnabled: true });
  queryClient.setQueryData([QueryKeys.endpoints], { [endpoint]: { type: EModelEndpoint.custom } });
  jest.spyOn(axios, 'post').mockResolvedValue({
    data: { enabled: true, decision: 'ALLOW', findings: [] },
  });

  const { result, unmount } = renderHook(
    () => {
      const [messages, updateMessages] = useState<TMessage[]>([]);
      const [submission, updateSubmission] = useState<TSubmission | null>(null);
      const [conversation, updateConversation] = useState<TConversation | null>(savedConversation);
      const [isSubmitting, updateIsSubmitting] = useState(false);
      const [, updateShowStopButton] = useState(false);
      const { ask } = useChatFunctions({
        conversation,
        getMessages: () => messages,
        setMessages: updateMessages,
        setSubmission: updateSubmission,
        isSubmitting,
        latestMessage: messages.at(-1) ?? null,
      });
      const { finalHandler } = useEventHandlers({
        getMessages: () => messages,
        setMessages: updateMessages,
        setConversation: updateConversation,
        setIsSubmitting: updateIsSubmitting,
        setShowStopButton: updateShowStopButton,
        setCompleted: jest.fn(),
      });
      return { ask, messages, submission, finalHandler };
    },
    {
      wrapper: ({ children }) => (
        <MemoryRouter
          initialEntries={['/c/conversation-1']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <QueryClientProvider client={queryClient}>
            <RecoilRoot>{children}</RecoilRoot>
          </QueryClientProvider>
        </MemoryRouter>
      ),
    },
  );

  try {
    act(() => result.current.ask({ text: iban }));
    await waitFor(() => expect(result.current.submission?.userMessage.text).toBe(iban));
    const first = result.current.submission;
    if (!first?.initialResponse) {
      throw new Error('Expected the first submitted message and response placeholder');
    }
    const responseMessage: TMessage = {
      ...first.initialResponse,
      messageId: 'completion-rejected-response',
      conversationId: savedConversation.conversationId,
      parentMessageId: first.userMessage.messageId,
      text: '',
      content: [{ type: ContentTypes.ERROR, error: '403 governance_blocked' }],
    };
    act(() => {
      result.current.finalHandler(
        {
          final: true,
          conversation: savedConversation,
          requestMessage: first.userMessage,
          responseMessage,
        },
        { ...first, initialResponse: first.initialResponse },
      );
    });
    expect(result.current.messages).toEqual([first.userMessage, responseMessage]);
    expect(
      queryClient.getQueryData([QueryKeys.messages, savedConversation.conversationId]),
    ).toEqual(result.current.messages);

    act(() => result.current.ask({ text: 'Tell me a short story.' }));
    await waitFor(() =>
      expect(result.current.submission?.userMessage.text).toBe('Tell me a short story.'),
    );
    expect(result.current.submission?.conversation.conversationId).toBe(
      savedConversation.conversationId,
    );
    expect(result.current.submission?.userMessage.parentMessageId).toBe(responseMessage.messageId);
    expect(result.current.submission?.messages).toEqual([first.userMessage, responseMessage]);
    expect(axios.post).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    queryClient.clear();
  }
});
