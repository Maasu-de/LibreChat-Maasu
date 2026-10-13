export type GovernanceDecision = 'ALLOW' | 'WARN' | 'MASK' | 'BLOCK';

export interface GovernanceFinding {
  location: string;
  start: number;
  end: number;
  category: string;
  action: GovernanceDecision;
  replacement?: string;
}

export interface GovernanceMaskedContent {
  location: string;
  text: string;
}

/** Findings in an attached file, counted by category and action. The file's text is not sent. */
export interface GovernanceFileFinding {
  filename: string;
  category: string;
  action: GovernanceDecision;
  count: number;
}

export interface GovernanceDlpResult {
  decision: GovernanceDecision;
  policyVersion?: number;
  findings: GovernanceFinding[];
  maskedPreview?: GovernanceMaskedContent[];
  fileFindings?: GovernanceFileFinding[];
}

/** Location that the findings and masked preview of a DLP review give for the submitted text. */
export const GOVERNANCE_DLP_TEXT_LOCATION = '/messages/0/content';

/**
 * A DLP review the Governance Backend returned instead of a completion. Findings and the masked
 * preview refer to the submitted text at `GOVERNANCE_DLP_TEXT_LOCATION`; findings in attached
 * files are listed per file in `fileFindings`. Sending that text again with `dlpReviewId` sends
 * the approved request to the model.
 */
export interface GovernanceDlpReview extends GovernanceDlpResult {
  reviewId: string;
  expiresAt?: number;
}
