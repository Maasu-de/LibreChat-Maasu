import React, { useState } from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Constants,
  QueryKeys,
  EModelEndpoint,
  encodeEphemeralAgentId,
} from 'librechat-data-provider';
import type { TMessage, TSubmission, TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { TPendingDlpReview } from '~/common';
import DlpInterventionDialog from '~/components/Chat/Input/DlpInterventionDialog';
import useChatFunctions from '../useChatFunctions';
import store from '~/store';

const mockShowToast = jest.fn();

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  startupConfigKey: (loggedIn: boolean) => ['startupConfig', loggedIn],
}));

jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => jest.fn());
jest.mock('~/hooks/Conversations/useGetSender', () => () => () => 'AI');
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: () => undefined }));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: { log: jest.fn(), dir: jest.fn(), warn: jest.fn() },
}));

const endpoint = 'AI Governance Gateway' as EModelEndpoint;
const model = 'governed-model';
const email = 'Please email max@example.com today';
const maskedEmail = 'Please email [EMAIL] today';
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

const maskReview = (conversationId: string | null): TPendingDlpReview => ({
  text: email,
  conversationId,
  result: {
    reviewId: 'review-1',
    decision: 'MASK',
    policyVersion: 5,
    findings: [
      {
        location: '/messages/0/content',
        start: 13,
        end: 28,
        category: 'EMAIL_ADDRESS',
        action: 'MASK',
        replacement: '[EMAIL]',
      },
    ],
    maskedPreview: [{ location: '/messages/0/content', text: maskedEmail }],
  },
});

const blockReview: TPendingDlpReview = {
  text: 'My IBAN is DE89370400440532013000',
  conversationId: savedConversation.conversationId,
  result: {
    reviewId: 'review-2',
    decision: 'BLOCK',
    findings: [
      {
        location: '/messages/0/content',
        start: 11,
        end: 33,
        category: 'IBAN_CODE',
        action: 'BLOCK',
      },
    ],
  },
};

const setSubmission = jest.fn<void, Parameters<SetterOrUpdater<TSubmission | null>>>();
const setMessages = jest.fn<void, [TMessage[]]>();

/** Stands in for the stream handler, which stores the review a turn ended with. */
function ReviewFromStream({ review }: { review: TPendingDlpReview }) {
  const setReview = useSetRecoilState(store.dlpReviewByIndex(0));
  return <button aria-label="Stream review" onClick={() => setReview(review)} />;
}

/** Stands in for the stream handler, which reopens a review whose approved send failed. */
function FailedSendFromStream() {
  const setReview = useSetRecoilState(store.dlpReviewByIndex(0));
  return (
    <button
      aria-label="Fail send"
      onClick={() => setReview((review) => review && { ...review, status: 'failed' })}
    />
  );
}

/** Stands in for the `$` popover, which queues a skill for the next message. */
function QueueSkill({ conversationId, skill }: { conversationId: string; skill: string }) {
  const setSkills = useSetRecoilState(store.pendingManualSkillsByConvoId(conversationId));
  return (
    <button aria-label="Queue skill" onClick={() => setSkills((skills) => [...skills, skill])} />
  );
}

function Chat({
  conversation,
  review,
}: {
  conversation: TConversation;
  review: TPendingDlpReview;
}) {
  const [text, setText] = useState('');
  const { ask, pendingDlpReview, cancelDlpIntervention, confirmDlpIntervention } = useChatFunctions(
    {
      conversation,
      getMessages: () => [],
      setMessages,
      setSubmission,
      isSubmitting: false,
      latestMessage: null,
    },
  );

  return (
    <>
      <input aria-label="Prompt" value={text} onChange={(event) => setText(event.target.value)} />
      <button aria-label="Send" onClick={() => ask({ text })} />
      <ReviewFromStream review={review} />
      <FailedSendFromStream />
      <QueueSkill
        conversationId={conversation.conversationId ?? Constants.NEW_CONVO}
        skill="queued-later"
      />
      {pendingDlpReview && (
        <DlpInterventionDialog
          result={pendingDlpReview.result}
          originalText={pendingDlpReview.text}
          sendFailed={pendingDlpReview.status === 'failed'}
          onCancel={cancelDlpIntervention}
          onConfirm={confirmDlpIntervention}
        />
      )}
    </>
  );
}

function renderChat(conversation: TConversation, review: TPendingDlpReview) {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.endpoints], { [endpoint]: { type: EModelEndpoint.custom } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>{children}</RecoilRoot>
      </QueryClientProvider>
    </MemoryRouter>
  );
  return render(<Chat conversation={conversation} review={review} />, { wrapper });
}

function lastSubmission(): TSubmission {
  const submission = setSubmission.mock.calls.at(-1)?.[0];
  if (submission == null || typeof submission === 'function') {
    throw new Error('Expected a chat submission');
  }
  return submission;
}

beforeEach(() => {
  setSubmission.mockClear();
  setMessages.mockClear();
  mockShowToast.mockClear();
});

it('sends a message at once, without a separate DLP check', () => {
  renderChat(savedConversation, maskReview(savedConversation.conversationId));

  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(setSubmission).toHaveBeenCalledTimes(1);
  expect(lastSubmission().userMessage.text).toBe(email);
  expect(lastSubmission().dlpReviewId).toBeUndefined();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each([savedConversation, newConversation])(
  'sends the masked text with the review ID once the user confirms, in conversation $conversationId',
  (conversation) => {
    renderChat(conversation, maskReview(conversation.conversationId));

    fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('[EMAIL]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));

    expect(setSubmission).toHaveBeenCalledTimes(1);
    expect(lastSubmission().userMessage.text).toBe(maskedEmail);
    expect(lastSubmission().dlpReviewId).toBe('review-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
);

it('shows the review again when its approved send fails, so it can be sent again', () => {
  renderChat(savedConversation, maskReview(savedConversation.conversationId));

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_dlp_send_failed')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Fail send' }));

  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('com_ui_dlp_send_failed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));

  expect(setSubmission).toHaveBeenCalledTimes(2);
  expect(lastSubmission().userMessage.text).toBe(maskedEmail);
  expect(lastSubmission().dlpReviewId).toBe('review-1');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it("sends the reviewed turn's $ skills with the approved text, and keeps newer ones queued", () => {
  renderChat(savedConversation, {
    ...maskReview(savedConversation.conversationId),
    manualSkills: ['brand-voice'],
  });

  fireEvent.click(screen.getByRole('button', { name: 'Queue skill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));

  expect(lastSubmission().dlpReviewId).toBe('review-1');
  expect(lastSubmission().manualSkills).toEqual(['brand-voice']);
  expect(lastSubmission().userMessage.manualSkills).toEqual(['brand-voice']);

  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(lastSubmission().manualSkills).toEqual(['queued-later']);
});

it('keeps the review open and says so when it has no approved text to send', () => {
  const review = maskReview(savedConversation.conversationId);
  renderChat(savedConversation, { ...review, result: { ...review.result, maskedPreview: [] } });

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));

  expect(setSubmission).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalledWith({
    message: 'com_ui_dlp_approval_unavailable',
    status: 'error',
  });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('shows a BLOCK review without a way to send the message', () => {
  renderChat(savedConversation, blockReview);

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));

  expect(screen.getByText('com_ui_dlp_block_title')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_dlp_continue')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(setSubmission).not.toHaveBeenCalled();
});

it('drops a review once the chat moves to another conversation', () => {
  const review = maskReview(savedConversation.conversationId);
  const { rerender } = renderChat(savedConversation, review);

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(
    <Chat conversation={{ ...savedConversation, conversationId: 'other' }} review={review} />,
  );

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
