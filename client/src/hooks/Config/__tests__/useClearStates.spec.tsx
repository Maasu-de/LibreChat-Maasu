import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import type { TPendingDlpReview } from '~/common';
import useClearStates from '../useClearStates';
import store from '~/store';

const firstTurnText = 'Please email max@example.com today';
const firstTurnReview: TPendingDlpReview = {
  text: firstTurnText,
  conversationId: null,
  result: {
    reviewId: 'review-1',
    decision: 'MASK',
    findings: [],
    maskedPreview: [{ location: '/messages/0/content', text: 'Please email [EMAIL] today' }],
  },
};

function useAuthResetState() {
  const clearStates = useClearStates();
  const review = useRecoilValue(store.dlpReviewByIndex(0));
  const text = useRecoilValue(store.textByIndex(0));
  return { clearStates, review, text };
}

it('clears a pending first-turn DLP review and its text during an authentication reset', async () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.conversationKeysAtom, [0]);
        set(store.dlpReviewByIndex(0), firstTurnReview);
        set(store.textByIndex(0), firstTurnText);
      }}
    >
      {children}
    </RecoilRoot>
  );
  const { result } = renderHook(useAuthResetState, { wrapper });

  expect(result.current.review).toEqual(firstTurnReview);
  expect(result.current.text).toBe(firstTurnText);

  await act(async () => {
    await result.current.clearStates();
  });

  expect(result.current.review).toBeNull();
  expect(result.current.text).toBe('');
});
