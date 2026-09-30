import { isEphemeralAgentId } from 'librechat-data-provider';
import type {
  TPayload,
  TEndpointOption,
  TEphemeralAgent,
  GovernanceDecision,
  GovernanceDlpReview,
} from 'librechat-data-provider';
import type { GatewayReview, ReviewStore } from './review';
import type { ServerRequest } from '~/types/http';
import {
  maskText,
  readReview,
  reviewTtl,
  getReviewStore,
  toClientReview,
  findSubmittedText,
  findingsInSubmittedText,
} from './review';
import { isEnabled } from '~/utils/common';

const DLP_CHAT_COMPLETIONS_PATH = '/api/v1/dlp/chat/completions';
/** Base path under which the gateway serves completions and models. */
const GATEWAY_BASE_PATH = /\/api\/v1\/dlp$/;
const LIBRECHAT_USER_HEADER = 'X-LibreChat-User-ID';

const DLP_FAILURE_MESSAGE =
  'The message could not be checked against the data loss prevention policy. Please try again later.';
const DLP_REVIEW_PENDING_MESSAGE = 'This message needs your review before it is sent to the model.';
const DLP_APPROVAL_INVALID_MESSAGE =
  'The approval for this message is no longer valid. Please send the message again.';
const DLP_UNSUPPORTED_MESSAGE =
  'This message could not be checked against your organization\'s data loss prevention policy because the "Use Responses API" option is enabled. Turn it off for this conversation to continue. No content was sent to the model.';

export type {
  GovernanceDecision,
  GovernanceFinding,
  GovernanceMaskedContent,
} from 'librechat-data-provider';

export interface GovernanceChatMessage {
  role: string;
  content: string;
}

/** The text-only Chat Completions fields understood by the Governance Backend. */
export interface GovernanceChatCompletionRequest {
  model: string;
  messages: GovernanceChatMessage[];
  stream?: boolean;
  temperature?: number;
  /** Return a review instead of calling the model when DLP finds anything. */
  require_user_approval?: boolean;
  /** Approval token of the stage 1 review being completed. */
  dlp_token?: string;
}

export type GovernanceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GovernanceFetchParams {
  userId: string;
  fetch?: GovernanceFetch;
  /** The user's submitted text, which reviews and approvals are bound to. */
  text?: string;
  /** Review the user approved; its stored request is sent instead of the rebuilt one. */
  reviewId?: string;
  /** Receives a review the user has to decide on. The model call then ends without a completion. */
  onReview?: (review: GovernanceDlpReview) => void;
  reviews?: ReviewStore;
}

export class GovernanceDlpError extends Error {
  code: string;

  constructor(code: string, message: string = DLP_FAILURE_MESSAGE) {
    super(message);
    this.name = 'GovernanceDlpError';
    this.code = code;
  }
}

export function isGovernanceDlpEnabled(): boolean {
  return isEnabled(process.env.GOVERNANCE_DLP_ENABLED);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function gatewayRoot(value: string): string {
  return trimTrailingSlash(value).replace(GATEWAY_BASE_PATH, '');
}

function getDlpConfiguration(): { gatewayUrl: string; serviceCredential: string } {
  const gatewayUrl = gatewayRoot(process.env.GOVERNANCE_API_BASE_URL ?? '');
  const serviceCredential = process.env.LIBRECHAT_SERVICE_CREDENTIAL ?? '';

  if (!gatewayUrl || !serviceCredential) {
    throw new GovernanceDlpError('dlp_check_not_configured');
  }

  return { gatewayUrl, serviceCredential };
}

function normalizeDecision(value: string | undefined): GovernanceDecision {
  const decision = value?.toUpperCase();
  if (decision === 'ALLOW' || decision === 'WARN' || decision === 'MASK' || decision === 'BLOCK') {
    return decision;
  }
  throw new GovernanceDlpError('dlp_check_malformed_response');
}

/** The message-form request body fields that decide whether a send takes the DLP approval flow. */
export type GovernanceSubmissionBody = Partial<
  Pick<
    TPayload,
    | 'text'
    | 'model'
    | 'files'
    | 'tools'
    | 'agent_id'
    | 'assistant_id'
    | 'isContinued'
    | 'isRegenerate'
    | 'addedConvo'
    | 'editedContent'
    | 'ephemeralAgent'
  >
> & {
  endpointOption?: Pick<TEndpointOption, 'model' | 'model_parameters' | 'modelOptions'>;
};

/** True when the ephemeral agent has any tool selected that would bypass a plain-text send. */
export function hasSelectedTools(ephemeralAgent?: TEphemeralAgent | null): boolean {
  return (
    (Array.isArray(ephemeralAgent?.mcp) && ephemeralAgent.mcp.length > 0) ||
    ephemeralAgent?.web_search === true ||
    ephemeralAgent?.file_search === true ||
    ephemeralAgent?.execute_code === true
  );
}

/** True for a plain-text message, including follow-ups using an ephemeral agent ID. */
export function isPlainTextSubmission(body: GovernanceSubmissionBody): boolean {
  return (
    typeof body?.text === 'string' &&
    body.text.trim().length > 0 &&
    body.editedContent == null &&
    body.isContinued !== true &&
    body.isRegenerate !== true &&
    body.addedConvo == null &&
    (body.agent_id == null ||
      (typeof body.agent_id === 'string' && isEphemeralAgentId(body.agent_id))) &&
    body.assistant_id == null &&
    (body.files == null || (Array.isArray(body.files) && body.files.length === 0)) &&
    (body.tools == null || (Array.isArray(body.tools) && body.tools.length === 0)) &&
    !hasSelectedTools(body.ephemeralAgent)
  );
}

/** True when an OpenAI-compatible completion base URL targets the configured gateway. */
export function isGovernanceGatewayUrl(completionBaseUrl: string): boolean {
  return gatewayRoot(completionBaseUrl) === getDlpConfiguration().gatewayUrl;
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function getRequestPathname(input: RequestInfo | URL): string {
  return new URL(getRequestUrl(input), 'http://localhost').pathname;
}

/** The gateway's only completion endpoint, which scans, masks and blocks in the same call. */
function isDlpChatCompletionsUrl(input: RequestInfo | URL): boolean {
  return getRequestPathname(input).endsWith(DLP_CHAT_COMPLETIONS_PATH);
}

/**
 * The OpenAI Responses API (`/responses`) sends user content in a request shape the Governance
 * Backend does not accept, so it cannot be scanned. Such a request must fail closed rather than
 * be sent on without DLP enforcement.
 */
function isResponsesApiUrl(input: RequestInfo | URL): boolean {
  return getRequestPathname(input).endsWith('/responses');
}

async function getRequestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | undefined> {
  if (typeof init?.body === 'string') {
    return init.body;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.clone().text();
  }
  return undefined;
}

function isTextMessage(value: unknown): value is GovernanceChatMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as { role?: unknown; content?: unknown };
  return (
    typeof message.role === 'string' &&
    typeof message.content === 'string' &&
    Object.keys(message).every((key) => key === 'role' || key === 'content')
  );
}

function parseChatCompletionRequest(body: string): GovernanceChatCompletionRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const request = value as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
    temperature?: unknown;
  };
  if (
    typeof request.model !== 'string' ||
    !Array.isArray(request.messages) ||
    !request.messages.every(isTextMessage) ||
    (request.stream !== undefined && typeof request.stream !== 'boolean') ||
    (request.temperature !== undefined &&
      (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature)))
  ) {
    return undefined;
  }

  return {
    model: request.model,
    messages: request.messages,
    ...(typeof request.stream === 'boolean' ? { stream: request.stream } : {}),
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
  };
}

function withGovernanceRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  request: GovernanceChatCompletionRequest,
  userId: string,
): RequestInit {
  const requestHeaders =
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(requestHeaders);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(LIBRECHAT_USER_HEADER, userId);
  return { ...init, body: JSON.stringify(request), headers };
}

/** A 400 ends the model call without the SDK retrying it, as it would a thrown fetch error. */
function governanceErrorResponse(code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'governance_review', code } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ApprovalParams {
  input: RequestInfo | URL;
  init?: RequestInit;
  request: GovernanceChatCompletionRequest;
  userId: string;
  text: string;
  reviewId?: string;
  onReview: (review: GovernanceDlpReview) => void;
  fetch: GovernanceFetch;
  reviews: ReviewStore;
}

function withApproval(
  { input, init, request, userId }: ApprovalParams,
  messages: GovernanceChatMessage[],
  dlpToken?: string,
): RequestInit {
  const approval: GovernanceChatCompletionRequest = {
    ...request,
    messages,
    require_user_approval: true,
    ...(dlpToken !== undefined ? { dlp_token: dlpToken } : {}),
  };
  return withGovernanceRequest(input, init, approval, userId);
}

/**
 * Handles a stage 1 review. Findings outside the submitted text were approved in earlier turns,
 * so such a review is completed at once. Otherwise the review is stored for the user's approval
 * and handed to `onReview`, and the model call ends.
 */
async function handleReview(params: ApprovalParams, review: GatewayReview): Promise<Response> {
  const decision = normalizeDecision(review.action);
  const submitted = findSubmittedText(params.request.messages, params.text);
  if (!submitted) {
    return governanceErrorResponse('dlp_check_unsupported_request', DLP_FAILURE_MESSAGE);
  }

  const findings = findingsInSubmittedText(review.findings ?? [], submitted);
  if (decision === 'BLOCK') {
    params.onReview(toClientReview(review, decision, findings));
    return governanceErrorResponse('dlp_review_required', DLP_REVIEW_PENDING_MESSAGE);
  }

  const { messages, dlp_token: dlpToken } = review;
  if (!messages || !dlpToken) {
    return governanceErrorResponse('dlp_check_malformed_response', DLP_FAILURE_MESSAGE);
  }
  if (findings.length === 0) {
    return params.fetch(params.input, withApproval(params, messages, dlpToken));
  }

  const approvedText = maskText(params.text, findings);
  if (!messages[submitted.messageIndex]?.content.endsWith(approvedText)) {
    return governanceErrorResponse('dlp_check_malformed_response', DLP_FAILURE_MESSAGE);
  }

  await params.reviews.set(
    review.review_id,
    {
      userId: params.userId,
      model: params.request.model,
      text: approvedText,
      messages,
      dlpToken,
    },
    reviewTtl(review.expires_at),
  );
  params.onReview(toClientReview(review, decision, findings, approvedText));
  return governanceErrorResponse('dlp_review_required', DLP_REVIEW_PENDING_MESSAGE);
}

/** Sends the approved stage 2 request, or stage 1 with `require_user_approval`. */
async function sendForApproval(params: ApprovalParams): Promise<Response> {
  const { input, request, userId, text, reviewId, reviews } = params;
  if (reviewId !== undefined) {
    const stored = await reviews.get(reviewId);
    if (
      !stored ||
      stored.userId !== userId ||
      stored.model !== request.model ||
      stored.text !== text
    ) {
      return governanceErrorResponse('dlp_approval_invalid', DLP_APPROVAL_INVALID_MESSAGE);
    }
    return params.fetch(input, withApproval(params, stored.messages, stored.dlpToken));
  }

  const stage1 = await params.fetch(input, withApproval(params, request.messages));
  const { review, response } = await readReview(stage1);
  if (!review) {
    return response;
  }
  await response.body?.cancel();
  return handleReview(params, review);
}

/**
 * Reduces a governed completion to the allow-listed text request before it is streamed to the
 * Governance Backend, leaving the response stream untouched. The gateway enforces DLP on that
 * request itself and, with `onReview`, pauses for the user's approval. A governed completion sent
 * through an unsupported request shape (currently the Responses API) is rejected here rather than
 * forwarded unscanned.
 */
export function createGovernanceDlpFetch({
  userId,
  fetch = globalThis.fetch,
  text = '',
  reviewId,
  onReview,
  reviews,
}: GovernanceFetchParams): GovernanceFetch {
  return async (input, init) => {
    if (isResponsesApiUrl(input)) {
      throw new GovernanceDlpError('dlp_check_unsupported_request', DLP_UNSUPPORTED_MESSAGE);
    }

    if (!isDlpChatCompletionsUrl(input)) {
      return fetch(input, init);
    }

    const body = await getRequestBody(input, init);
    const request = body ? parseChatCompletionRequest(body) : undefined;
    if (!request) {
      throw new GovernanceDlpError('dlp_check_unsupported_request');
    }

    if (!onReview) {
      return fetch(input, withGovernanceRequest(input, init, request, userId));
    }
    return sendForApproval({
      input,
      init,
      request,
      userId,
      text,
      reviewId,
      onReview,
      fetch,
      reviews: reviews ?? getReviewStore(),
    });
  };
}

/** The governed fetch for one chat request. A review the user has to decide on is set on `req`. */
export function createRequestDlpFetch(
  req: ServerRequest,
  fetch?: GovernanceFetch,
): GovernanceFetch {
  const { text, dlpReviewId } = req.body ?? {};
  return createGovernanceDlpFetch({
    userId: req.user?.id ?? '',
    fetch,
    text: typeof text === 'string' ? text : '',
    reviewId: typeof dlpReviewId === 'string' && dlpReviewId !== '' ? dlpReviewId : undefined,
    onReview: (review) => {
      req.governanceDlpReview = review;
    },
  });
}
