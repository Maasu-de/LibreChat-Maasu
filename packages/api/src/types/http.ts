import type { TConversation, TEndpointOption, GovernanceDlpReview } from 'librechat-data-provider';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { Request } from 'express';

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
  /** A DLP review of this request that the user has to decide on before the model is called. */
  governanceDlpReview?: GovernanceDlpReview;
  /**
   * `false` until the gateway starts this turn's governed completion, `true` from then on, and
   * unset for a turn that is not governed. An unsent turn stores nothing.
   */
  governanceDlpSent?: boolean;
  /** Run once when `governanceDlpSent` turns `true`. */
  governanceDlpSentCallbacks?: Array<() => void>;
};
