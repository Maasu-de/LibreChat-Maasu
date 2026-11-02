jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn(),
}));

jest.mock('~/store', () => ({
  saveDrafts: { key: 'saveDrafts', default: true },
}));

jest.mock('~/Providers', () => ({
  useChatFormContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetFiles: jest.fn(),
}));

import React from 'react';
import { TextDecoder, TextEncoder } from 'util';
import { renderHook, act } from '@testing-library/react';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { useChatFormContext } from '~/Providers';
import { clearAllDrafts, getDraft, setDraft } from '~/utils';
import { useGetFiles } from '~/data-provider';
import { useAutoSave } from '~/hooks';
import store from '~/store';

/** jsdom lacks these, and without them `encodeBase64` silently stores every draft as '' */
Object.assign(global, { TextEncoder, TextDecoder });

type Props = { conversationId: string; isSubmitting: boolean };

const NEW_CONVO = Constants.NEW_CONVO as string;
const CONVO_ID = '5f0c2b7e-0d4a-4c1e-9b8a-1f2e3d4c5b6a';

let textarea: HTMLTextAreaElement;

const type = (value: string) => {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
};

const renderAutoSave = (conversationId = CONVO_ID) => {
  const textAreaRef = { current: textarea } as React.RefObject<HTMLTextAreaElement>;
  return renderHook(
    (props: Props) => useAutoSave({ ...props, textAreaRef, files: new Map(), setFiles: jest.fn() }),
    { initialProps: { conversationId, isSubmitting: false } },
  );
};

type Rerender = ReturnType<typeof renderAutoSave>['rerender'];

/** What `submitMessage` does: the turn starts and the composer is reset in the same batch */
const send = (rerender: Rerender, conversationId = CONVO_ID) =>
  act(() => {
    textarea.value = '';
    rerender({ conversationId, isSubmitting: true });
  });

/** What `useResumableSSE` does on `final`: drop the turn's drafts, then stop submitting */
const finishResponse = (rerender: Rerender, conversationId = CONVO_ID, sourceId = conversationId) =>
  act(() => {
    clearAllDrafts(sourceId);
    rerender({ conversationId, isSubmitting: false });
  });

const typeDuringResponse = (...steps: Array<[value: string, elapsedMs: number]>) =>
  act(() => {
    for (const [value, elapsedMs] of steps) {
      type(value);
      jest.advanceTimersByTime(elapsedMs);
    }
  });

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  textarea = document.createElement('textarea');
  (useRecoilValue as jest.Mock).mockImplementation((atom) => atom === store.saveDrafts);
  (useChatFormContext as jest.Mock).mockReturnValue({
    setValue: (_name: string, value: string) => {
      textarea.value = value;
    },
  });
  (useGetFiles as jest.Mock).mockReturnValue({ data: [] });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('useAutoSave — response completion', () => {
  it('keeps text typed while the response was generating', () => {
    const { rerender } = renderAutoSave();
    send(rerender);
    typeDuringResponse(['Next question', 100]);

    finishResponse(rerender);

    expect(textarea.value).toBe('Next question');
  });

  it('keeps the last keystrokes typed right before the response completes', () => {
    const { rerender } = renderAutoSave();
    send(rerender);
    typeDuringResponse(['Next questio', 100], ['Next question', 10]);

    finishResponse(rerender);

    expect(textarea.value).toBe('Next question');
    expect(getDraft(CONVO_ID)).toBe('Next question');
  });

  it('keeps a one-character draft', () => {
    const { rerender } = renderAutoSave();
    send(rerender);
    typeDuringResponse(['N', 100]);

    finishResponse(rerender);

    expect(textarea.value).toBe('N');
  });

  it('does not bring back text deleted right before the response completes', () => {
    const { rerender } = renderAutoSave();
    send(rerender);
    typeDuringResponse(['Never mind', 100], ['', 100]);

    finishResponse(rerender);

    expect(textarea.value).toBe('');
    expect(getDraft(CONVO_ID)).toBe('');
  });

  it('keeps the draft when the stream reopens after completing and completes again', () => {
    const { rerender } = renderAutoSave();
    send(rerender);
    finishResponse(rerender);
    typeDuringResponse(['Draft for the next turn', 100]);

    act(() => rerender({ conversationId: CONVO_ID, isSubmitting: true }));
    expect(textarea.value).toBe('Draft for the next turn');

    finishResponse(rerender);
    expect(textarea.value).toBe('Draft for the next turn');
  });

  it('keeps text typed for the next message when DLP ends the turn within milliseconds', () => {
    const { rerender } = renderAutoSave();
    send(rerender);
    typeDuringResponse(['Also', 30], ['Also check', 5]);

    finishResponse(rerender);

    expect(textarea.value).toBe('Also check');
  });

  it('keeps the draft when DLP ends the first turn of a new chat before it gets an id', () => {
    const { rerender } = renderAutoSave(NEW_CONVO);
    send(rerender, NEW_CONVO);
    typeDuringResponse(['Also', 30], ['Also check', 5]);

    finishResponse(rerender, NEW_CONVO);

    expect(textarea.value).toBe('Also check');
    expect(getDraft(Constants.PENDING_CONVO)).toBe('');
  });

  it('keeps the draft when a new chat receives its id as the response completes', () => {
    const { rerender } = renderAutoSave(NEW_CONVO);
    send(rerender, NEW_CONVO);
    typeDuringResponse(['Follow-up', 100], ['Follow-up question', 10]);

    finishResponse(rerender, CONVO_ID, NEW_CONVO);

    expect(textarea.value).toBe('Follow-up question');
    expect(getDraft(CONVO_ID)).toBe('Follow-up question');
  });
});

describe('useAutoSave — intentional clearing and switching', () => {
  it('leaves the composer empty after sending, even when the turn ends without a final event', () => {
    const { rerender } = renderAutoSave();
    typeDuringResponse(['Hello worl', 100], ['Hello world', 5]);

    send(rerender);
    act(() => {
      jest.advanceTimersByTime(100);
      rerender({ conversationId: CONVO_ID, isSubmitting: false });
    });

    expect(textarea.value).toBe('');
    expect(getDraft(CONVO_ID)).toBe('');
  });

  it("shows the new chat's own draft when it is opened while a response is generating", () => {
    setDraft({ id: NEW_CONVO, value: 'Saved new-chat draft' });
    const { rerender } = renderAutoSave();
    send(rerender);
    typeDuringResponse(['Typed during the response', 100]);

    act(() => rerender({ conversationId: NEW_CONVO, isSubmitting: true }));
    act(() => rerender({ conversationId: NEW_CONVO, isSubmitting: false }));

    expect(textarea.value).toBe('Saved new-chat draft');
  });
});
