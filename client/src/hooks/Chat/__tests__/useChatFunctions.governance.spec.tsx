import React, { useState } from 'react';
import { RecoilRoot, useRecoilState, useSetRecoilState } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Constants,
  QueryKeys,
  FileSources,
  EModelEndpoint,
  encodeEphemeralAgentId,
} from 'librechat-data-provider';
import type { TMessage, TSubmission, TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { ExtendedFile, TPendingDlpReview } from '~/common';
import DlpInterventionDialog from '~/components/Chat/Input/DlpInterventionDialog';
import useChatFunctions from '../useChatFunctions';
import { ephemeralAgentByConvoId } from '~/store/agents';
import store from '~/store';

const mockShowToast = jest.fn();
/** Stable, like the real `useLocalize`. */
const mockLocalize = (key: string) => key;
/** Succeeds at once, like a delete the server accepts. */
const mockDeleteFiles = jest.fn((_vars: unknown, options?: { onSuccess?: () => void }) =>
  options?.onSuccess?.(),
);

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useLocalize: () => mockLocalize,
}));

/** The real ToastProvider makes a new `showToast` whenever a toast shows or hides. */
let mockToastContext: { showToast: (...args: unknown[]) => void } = { showToast: mockShowToast };

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => mockToastContext,
}));

jest.mock('~/data-provider', () => ({
  startupConfigKey: (loggedIn: boolean) => ['startupConfig', loggedIn],
  useDeleteFilesMutation: () => ({ mutate: mockDeleteFiles }),
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

const upload = (file_id: string, filename: string): ExtendedFile => ({
  file_id,
  temp_file_id: `temp-${file_id}`,
  filename,
  filepath: `/uploads/${file_id}`,
  source: FileSources.local,
  type: 'text/plain',
  size: 10,
  progress: 1,
});
const flaggedUpload = upload('flagged', 'iban.txt');
const cleanUpload = upload('clean', 'notes.txt');
const libraryFile: ExtendedFile = {
  file_id: 'library',
  filename: 'contract.txt',
  filepath: '/uploads/library',
  source: FileSources.local,
  type: 'text/plain',
  size: 10,
  progress: 1,
  attached: true,
};
const composerFiles = [flaggedUpload, cleanUpload, libraryFile];

/** A review of a message sent with an upload and a library file that have findings, and one without. */
const fileReview = (conversationId: string | null): TPendingDlpReview => {
  const review = maskReview(conversationId);
  return {
    ...review,
    files: composerFiles.map(({ file_id, filepath }) => ({ file_id, filepath })),
    result: {
      ...review.result,
      fileFindings: [
        { filename: 'iban.txt', fileId: 'flagged', category: 'IBAN', action: 'MASK', count: 1 },
        { filename: 'contract.txt', fileId: 'library', category: 'IBAN', action: 'MASK', count: 1 },
      ],
    },
  };
};

/** The same review blocked over the upload's finding, which can then never be sent. */
const blockedFileReview = (conversationId: string | null): TPendingDlpReview => {
  const review = fileReview(conversationId);
  return {
    ...review,
    result: {
      ...review.result,
      decision: 'BLOCK',
      maskedPreview: undefined,
      fileFindings: review.result.fileFindings?.map((finding) =>
        finding.fileId === 'flagged' ? { ...finding, action: 'BLOCK' } : finding,
      ),
    },
  };
};

const flaggedUploadDeletion = {
  file_id: 'flagged',
  filepath: '/uploads/flagged',
  source: FileSources.local,
  embedded: false,
};

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
  const [files, setFiles] = useRecoilState(store.filesByIndex(0));
  const { ask, pendingDlpReview, cancelDlpIntervention, confirmDlpIntervention } = useChatFunctions(
    {
      conversation,
      getMessages: () => [],
      setMessages,
      files,
      setFiles,
      setSubmission,
      isSubmitting: false,
      latestMessage: null,
    },
  );

  return (
    <>
      <input aria-label="Prompt" value={text} onChange={(event) => setText(event.target.value)} />
      <button
        aria-label="Attach files"
        onClick={() =>
          setFiles(new Map(composerFiles.map((file) => [file.temp_file_id ?? file.file_id, file])))
        }
      />
      <ul aria-label="Composer files">
        {Array.from(files.values(), (file) => (
          <li key={file.file_id}>{file.file_id}</li>
        ))}
      </ul>
      <button aria-label="Send" onClick={() => ask({ text })} />
      <button aria-label="Close review" onClick={cancelDlpIntervention} />
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

function renderChat(
  conversation: TConversation,
  review: TPendingDlpReview,
  governancePilotEnabled = false,
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.endpoints], { [endpoint]: { type: EModelEndpoint.custom } });
  queryClient.setQueryData(['startupConfig', true], { governancePilotEnabled });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }) =>
            set(ephemeralAgentByConvoId(conversation.conversationId ?? Constants.NEW_CONVO), {
              web_search: true,
              execute_code: true,
            })
          }
        >
          {children}
        </RecoilRoot>
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
  mockDeleteFiles.mockClear();
  mockToastContext = { showToast: mockShowToast };
});

/** Sends a message with the composer files, which the stream then holds for `review`. */
function sendWithFilesForReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
}

const composerFileIds = () =>
  Array.from(
    screen.getByRole('list', { name: 'Composer files', hidden: true }).querySelectorAll('li'),
    (item) => item.textContent,
  );

it('sends a message at once, without a separate DLP check', () => {
  renderChat(savedConversation, maskReview(savedConversation.conversationId));

  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(setSubmission).toHaveBeenCalledTimes(1);
  expect(lastSubmission().userMessage.text).toBe(email);
  expect(lastSubmission().dlpReviewId).toBeUndefined();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each([false, true])(
  'leaves out hidden tool selections and $ skills only in the governed pilot (%s)',
  (governancePilotEnabled) => {
    renderChat(
      savedConversation,
      maskReview(savedConversation.conversationId),
      governancePilotEnabled,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Queue skill' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'plain text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(setSubmission).toHaveBeenCalledTimes(1);
    if (governancePilotEnabled) {
      expect(lastSubmission().ephemeralAgent).toBeUndefined();
      expect(lastSubmission().manualSkills).toBeUndefined();
    } else {
      expect(lastSubmission().ephemeralAgent).toMatchObject({ web_search: true });
      expect(lastSubmission().manualSkills).toEqual(['queued-later']);
    }
  },
);

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
    expect(lastSubmission().userMessage.dlpMasks).toEqual([
      { start: 13, end: 20, category: 'EMAIL_ADDRESS', replacement: '[EMAIL]' },
    ]);
    expect(lastSubmission().dlpReviewId).toBe('review-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
);

it('puts no masks on the sent message when the approved text is not masked like the review', () => {
  const review = maskReview(savedConversation.conversationId);
  const gatewayText = 'Please email [REDACTED] today';
  renderChat(savedConversation, {
    ...review,
    result: {
      ...review.result,
      maskedPreview: [{ location: '/messages/0/content', text: gatewayText }],
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));

  expect(lastSubmission().userMessage.text).toBe(gatewayText);
  expect(lastSubmission().userMessage.dlpMasks).toBeUndefined();
});

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

it("sends the reviewed turn's files with the approved text, so the sent message shows them", () => {
  const files = [{ file_id: 'file-1', filename: 'report.pdf', filepath: '/files/report.pdf' }];
  renderChat(savedConversation, { ...maskReview(savedConversation.conversationId), files });

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));

  expect(lastSubmission().dlpReviewId).toBe('review-1');
  expect(lastSubmission().userMessage.files).toEqual(files);
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

it.each([
  ['com_ui_cancel', maskReview(savedConversation.conversationId)],
  ['com_ui_close', blockReview],
])("queues the review's $ skills again when it is dismissed with %s", (button, review) => {
  renderChat(savedConversation, { ...review, manualSkills: ['brand-voice'] });

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
    target: { value: 'Edited' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(lastSubmission().manualSkills).toEqual(['brand-voice']);
});

it("puts a cancelled review's $ skills ahead of skills queued since, once each", () => {
  renderChat(savedConversation, {
    ...maskReview(savedConversation.conversationId),
    manualSkills: ['brand-voice', 'queued-later'],
  });

  fireEvent.click(screen.getByRole('button', { name: 'Queue skill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
    target: { value: 'Edited' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(lastSubmission().manualSkills).toEqual(['brand-voice', 'queued-later']);
});

it.each([savedConversation, newConversation])(
  "queues the review's $ skills again in its conversation $conversationId when the chat moves away",
  (conversation) => {
    const review = { ...maskReview(conversation.conversationId), manualSkills: ['brand-voice'] };
    const { rerender } = renderChat(conversation, review);

    fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
    rerender(<Chat conversation={{ ...conversation, conversationId: 'other' }} review={review} />);
    rerender(<Chat conversation={conversation} review={review} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Edited' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(lastSubmission().manualSkills).toEqual(['brand-voice']);
  },
);

it('does not queue the $ skills of an approved review that is already on its way', () => {
  const review = { ...maskReview(savedConversation.conversationId), manualSkills: ['brand-voice'] };
  const { rerender } = renderChat(savedConversation, review);

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));
  rerender(
    <Chat conversation={{ ...savedConversation, conversationId: 'other' }} review={review} />,
  );
  rerender(<Chat conversation={savedConversation} review={review} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(lastSubmission().manualSkills).toBeUndefined();
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

it("keeps a new chat's review open when a toast renews `showToast`", () => {
  renderChat(newConversation, maskReview(null));

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));
  mockToastContext = { showToast: (...args) => mockShowToast(...args) };
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt', hidden: true }), {
    target: { value: 'typed while the review is open' },
  });

  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('drops a review for another conversation as soon as it arrives', () => {
  renderChat(newConversation, maskReview('stream-1'));

  fireEvent.click(screen.getByRole('button', { name: 'Stream review' }));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('puts all files of a cancelled review without blocked findings back', () => {
  renderChat(savedConversation, fileReview(savedConversation.conversationId));

  sendWithFilesForReview();
  expect(composerFileIds()).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));

  expect(mockDeleteFiles).not.toHaveBeenCalled();
  expect(composerFileIds()).toEqual(['flagged', 'clean', 'library']);
  expect(mockShowToast).not.toHaveBeenCalled();
});

it('deletes the blocked uploads of a closed review and puts its other files back', () => {
  renderChat(savedConversation, blockedFileReview(savedConversation.conversationId));

  sendWithFilesForReview();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));

  expect(mockDeleteFiles).toHaveBeenCalledTimes(1);
  expect(mockDeleteFiles).toHaveBeenCalledWith(
    { files: [flaggedUploadDeletion] },
    { onSuccess: expect.any(Function) },
  );
  expect(composerFileIds()).toEqual(['clean', 'library']);
  expect(mockShowToast).toHaveBeenCalledWith({
    message: 'com_ui_dlp_files_removed',
    status: 'warning',
  });
});

it("deletes all of an unsent review's uploads, but no library file, when the chat moves away", () => {
  const review = fileReview(savedConversation.conversationId);
  const { rerender } = renderChat(savedConversation, review);

  sendWithFilesForReview();
  rerender(
    <Chat conversation={{ ...savedConversation, conversationId: 'other' }} review={review} />,
  );

  expect(mockDeleteFiles).toHaveBeenCalledWith({
    files: [
      flaggedUploadDeletion,
      { file_id: 'clean', filepath: '/uploads/clean', source: FileSources.local, embedded: false },
    ],
  });
  expect(composerFileIds()).toEqual([]);
  expect(mockShowToast).not.toHaveBeenCalled();
});

it('keeps the files of an approved review, which were sent with it', () => {
  const review = fileReview(savedConversation.conversationId);
  const { rerender } = renderChat(savedConversation, review);

  sendWithFilesForReview();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' }));
  rerender(
    <Chat conversation={{ ...savedConversation, conversationId: 'other' }} review={review} />,
  );

  expect(lastSubmission().userMessage.files).toEqual(review.files);
  expect(mockDeleteFiles).not.toHaveBeenCalled();
});

it('hides a review whose approved send failed for good, which is then closed like a cancel', () => {
  const review = fileReview(savedConversation.conversationId);
  renderChat(savedConversation, { ...review, status: 'rejected' });

  sendWithFilesForReview();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));

  expect(mockDeleteFiles).not.toHaveBeenCalled();
  expect(composerFileIds()).toEqual(['flagged', 'clean', 'library']);
});
