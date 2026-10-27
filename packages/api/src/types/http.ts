import type { TConversation, TEndpointOption, GovernanceDlpReview } from 'librechat-data-provider';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { DlpFileContext } from '~/governance/review';

/**
 * LibreChat-specific request body type that extends Express Request body
 * (have to use type alias because you can't extend indexed access types like Request['body'])
 */
export type RequestBody = {
  messageId?: string;
  fileTokenLimit?: number;
  conversationId?: string;
  parentMessageId?: string;
  endpoint?: string;
  endpointType?: string;
  model?: string;
  key?: string;
  endpointOption?: Partial<TEndpointOption>;
  /** Browser IANA timezone used to resolve local-time prompt variables (e.g. `{{current_datetime}}`). */
  timezone?: string;
  text?: string;
  /** Governance DLP review the user approved for this message. */
  dlpReviewId?: string;
  /** The second conversation of a two-model comparison. */
  addedConvo?: Partial<TConversation>;
};

export type ServerRequest = Request<unknown, unknown, RequestBody> & {
  user?: IUser;
  config?: AppConfig;
  /** Server-captured conversation creation time used to anchor dynamic prompt variables. */
  conversationCreatedAt?: string;
  /** Conversation loaded while resolving the prompt timestamp anchor, reused by save logic. */
  resolvedConversation?: Partial<TConversation> | null;
  /** Passport strategy that populated req.user for this request. */
  authStrategy?: string;
  /** Set for plain-text sends, whose completion goes through the governed DLP approval flow. */
  governanceDlpEligible?: boolean;
  /** Server-resolved LibreChat group IDs used by the governed completion. */
  governanceGroupIds?: string[];
  /** The user message this turn's gateway calls are correlated with. */
  governanceMessageId?: string;
  /** The attached-document blocks this turn added to messages, for naming files in DLP findings. */
  governanceDlpFileContexts?: DlpFileContext[];
  /** A DLP review of this request that the user has to decide on before the model is called. */
  governanceDlpReview?: GovernanceDlpReview;
  /** Set when the approved review's last send failed and put it back, so it can be sent again. */
  governanceDlpApprovalKept?: boolean;
  /** Whether this comparison turn claimed the review the user approved, shared by both models. */
  governanceComparisonApproval?: Promise<boolean>;
  /** Resolves once both compared models' first gateway calls came back. */
  governanceComparisonSettled?: { remaining: number; settled: Promise<void>; settle: () => void };
  /**
   * `false` until the gateway starts this turn's governed completion, `true` from then on, and
   * unset for a turn that is not governed. An unsent turn stores nothing.
   */
  governanceDlpSent?: boolean;
  /** Run once when `governanceDlpSent` turns `true`. */
  governanceDlpSentCallbacks?: Array<() => void>;
};
