import React, { useState } from 'react';
import axios from 'axios';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, QueryKeys, encodeEphemeralAgentId } from 'librechat-data-provider';
import type {
  TMessage,
  TSubmission,
  TConversation,
  GovernanceDlpCheckRequest,
  GovernanceDlpCheckResponse,
} from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import DlpInterventionDialog from '~/components/Chat/Input/DlpInterventionDialog';
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
  logger: { log: jest.fn(), dir: jest.fn() },
  cn: jest.requireActual('~/utils/cn').default,
}));
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
