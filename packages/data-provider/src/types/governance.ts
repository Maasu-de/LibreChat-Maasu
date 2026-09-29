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

export interface GovernanceDlpResult {
  decision: GovernanceDecision;
  policyVersion?: number;
  findings: GovernanceFinding[];
  maskedPreview?: GovernanceMaskedContent[];
}

export interface GovernanceDlpCheckRequest {
  text: string;
  model: string;
}

export type GovernanceDlpCheckResponse =
  | { enabled: false }
  | ({ enabled: true } & GovernanceDlpResult);

/**
 * A DLP review the Governance Backend returned instead of a completion. Findings and the masked
 * preview refer to the submitted text at `/messages/0/content`. Sending that text again with
 * `dlpReviewId` sends the approved request to the model.
 */
export interface GovernanceDlpReview extends GovernanceDlpResult {
  reviewId: string;
  expiresAt?: number;
}
