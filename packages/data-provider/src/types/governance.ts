export type GovernanceDecision = 'ALLOW' | 'WARN' | 'MASK' | 'BLOCK';

export interface GovernanceFinding {
  location: string;
  start: number;
  end: number;
  category: string;
  /** How a tenant-defined category is shown to the user; built-in categories have none. */
  label?: string;
  action: GovernanceDecision;
  replacement?: string;
}

/** A replacement the gateway put in a masked text, as the code-point range it takes there. */
export interface GovernanceMaskedSpan {
  start: number;
  end: number;
  category: string;
  /** The text of the range, so a text changed since then is not taken for masked. */
  replacement: string;
}

export interface GovernanceMaskedContent {
  location: string;
  text: string;
  /** Where `text` holds the gateway's replacements, kept on the sent message. */
  masks?: GovernanceMaskedSpan[];
}

/** A code-point range of the submitted text that the gateway replaces. */
export interface GovernanceMaskedRange {
  start: number;
  end: number;
  /** Index in the review's `findings` of the finding whose replacement takes the range. */
  finding: number;
}

/**
 * Findings in an attached file, counted by category and action. Only the matched values are
 * sent, never the rest of the file's text.
 */
export interface GovernanceFileFinding {
  filename: string;
  /** Set for a file attached to the submitted message, which the user can still withdraw. */
  fileId?: string;
  /** The file's MIME type. */
  type?: string;
  category: string;
  label?: string;
  action: GovernanceDecision;
  count: number;
  /**
   * The matched values, in the order they first appear in the file. A value that differs from an
   * earlier one only in case or spacing is left out.
   */
  terms?: string[];
}

export interface GovernanceDlpResult {
  decision: GovernanceDecision;
  policyVersion?: number;
  findings: GovernanceFinding[];
  /** The ranges the gateway replaces, in text order, for every decision. */
  maskedRanges?: GovernanceMaskedRange[];
  maskedPreview?: GovernanceMaskedContent[];
  fileFindings?: GovernanceFileFinding[];
  /** Set when the content does not allow the selected model, which blocks the prompt. */
  modelNotAllowed?: { model: string; allowedTiers: GovernanceTier[] };
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

export interface GovernanceTier {
  code: string;
  name: string;
  description: string;
}

export interface GovernanceModel {
  id: string;
  governance_tier?: GovernanceTier | null;
}

export type GovernanceModelsConfig = Record<string, GovernanceModel[]>;

export const GOVERNANCE_ENDPOINT: string = 'AI Governance Gateway';
