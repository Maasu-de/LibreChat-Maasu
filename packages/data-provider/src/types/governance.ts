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
