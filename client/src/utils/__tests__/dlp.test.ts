import { GOVERNANCE_DLP_TEXT_LOCATION } from 'librechat-data-provider';
import type { TPendingDlpReview } from '~/common';
import { getApprovedDlpText, isUnsentDlpText } from '../dlp';

const ORIGINAL = 'My IBAN is DE89370400440532013000';
const MASKED = 'My IBAN is [IBAN]';

const review: TPendingDlpReview = {
  text: ORIGINAL,
  conversationId: 'convo-1',
  result: {
    reviewId: 'review-1',
    decision: 'MASK',
    findings: [],
    maskedPreview: [
      { location: '/messages/1/content', text: 'An earlier message' },
      { location: GOVERNANCE_DLP_TEXT_LOCATION, text: MASKED },
    ],
  },
};

describe('getApprovedDlpText', () => {
  it('returns the masked preview of the typed message', () => {
    expect(getApprovedDlpText(review.result)).toBe(MASKED);
  });

  it('returns undefined when the review has no preview of the typed message', () => {
    expect(getApprovedDlpText({ decision: 'WARN', findings: [] })).toBeUndefined();
  });
});

describe('isUnsentDlpText', () => {
  it('matches the message the review is about, as typed or as approved', () => {
    expect(isUnsentDlpText(review, ORIGINAL)).toBe(true);
    expect(isUnsentDlpText(review, MASKED)).toBe(true);
  });

  it('does not match text typed for the next message, or an empty composer', () => {
    expect(isUnsentDlpText(review, 'A follow-up question')).toBe(false);
    expect(isUnsentDlpText(review, '')).toBe(false);
  });
});
