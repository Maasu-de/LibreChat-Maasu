jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers'),
  useChatFormContext: jest.fn(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'token' }),
}));

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetFiles: () => ({ data: [] }),
}));

import React, { useState } from 'react';
import { RecoilRoot } from 'recoil';
import { TextDecoder, TextEncoder } from 'util';
import { MemoryRouter } from 'react-router-dom';
import { renderHook, act } from '@testing-library/react';
import { Constants } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EventSubmission, TMessage } from 'librechat-data-provider';
import type { TFinalResData } from '~/common';
import useEventHandlers from '~/hooks/SSE/useEventHandlers';
import { clearAllDrafts, getDraft } from '~/utils';
import { useChatFormContext } from '~/Providers';
import { useAutoSave } from '~/hooks';

/** jsdom lacks these, and without them `encodeBase64` silently stores every draft as '' */
Object.assign(global, { TextEncoder, TextDecoder });

const NEW_CONVO = Constants.NEW_CONVO as string;
const NO_PARENT = Constants.NO_PARENT as string;
const CONVO_ID = '5f0c2b7e-0d4a-4c1e-9b8a-1f2e3d4c5b6a';
const REVIEWED_TEXT = 'Mail me at max@example.com';
const NO_FILES = new Map();

const chats = [
  { chat: 'an existing chat', conversationId: CONVO_ID, parentMessageId: 'assistant-1' },
  { chat: 'a new chat', conversationId: NEW_CONVO, parentMessageId: NO_PARENT },
];

let textarea: HTMLTextAreaElement;

const type = (value: string) => {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
};

/** The composer's side of a turn: the real `finalHandler` ends it and `useAutoSave` reacts */
const useTurn = (conversationId: string) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { finalHandler } = useEventHandlers({
    setIsSubmitting,
    getMessages: () => [],
    setMessages: () => undefined,
    setCompleted: () => undefined,
    setShowStopButton: () => undefined,
  });
  useAutoSave({
    isSubmitting,
    conversationId,
    textAreaRef: { current: textarea },
    files: NO_FILES,
    setFiles: () => undefined,
  });
  return { finalHandler, setIsSubmitting };
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <RecoilRoot>
      <MemoryRouter initialEntries={[`/c/${NEW_CONVO}`]}>{children}</MemoryRouter>
    </RecoilRoot>
  </QueryClientProvider>
);

const renderTurn = (conversationId: string) => {
  const { result } = renderHook(() => useTurn(conversationId), { wrapper });

  /** What `submitMessage` does: the turn starts and the composer is reset in the same batch */
  const send = () =>
    act(() => {
      textarea.value = '';
      result.current.setIsSubmitting(true);
    });

  /** What `useResumableSSE` does when the server holds a message for review */
  const endWithReview = (parentMessageId: string) =>
    act(() => {
      clearAllDrafts(conversationId);
      result.current.finalHandler(
        {
          final: true,
          aborted: true,
          earlyAbort: true,
          requestMessage: { text: REVIEWED_TEXT },
          responseMessage: null,
        } as unknown as TFinalResData,
        {
          messages: [],
          conversation: { conversationId },
          userMessage: { parentMessageId } as TMessage,
        } as unknown as EventSubmission,
      );
    });

  return { send, endWithReview };
};

const typeBeforeReview = (...values: string[]) =>
  act(() => {
    for (const value of values) {
      type(value);
      jest.advanceTimersByTime(100);
    }
  });

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  textarea = document.createElement('textarea');
  (useChatFormContext as jest.Mock).mockReturnValue({
    setValue: (_name: string, value: string) => {
      textarea.value = value;
    },
  });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe.each(chats)('useAutoSave — DLP review in $chat', ({ conversationId, parentMessageId }) => {
  it('puts the reviewed message back when the composer was not touched', () => {
    const { send, endWithReview } = renderTurn(conversationId);
    send();

    endWithReview(parentMessageId);

    expect(textarea.value).toBe(REVIEWED_TEXT);
    expect(getDraft(conversationId)).toBe(REVIEWED_TEXT);
  });

  it('keeps a follow-up typed before the review opened', () => {
    const { send, endWithReview } = renderTurn(conversationId);
    send();
    typeBeforeReview('Next question');

    endWithReview(parentMessageId);

    expect(textarea.value).toBe('Next question');
    expect(getDraft(conversationId)).toBe('Next question');
  });

  it.each([
    ['inside', 0],
    ['after', 1000],
  ])('stays empty when a follow-up is deleted %s the empty-draft debounce', (_when, waitMs) => {
    const { send, endWithReview } = renderTurn(conversationId);
    send();
    typeBeforeReview('Never mind', '');
    act(() => {
      jest.advanceTimersByTime(waitMs);
    });

    endWithReview(parentMessageId);

    expect(textarea.value).toBe('');
    expect(getDraft(conversationId)).toBe('');
  });
});
