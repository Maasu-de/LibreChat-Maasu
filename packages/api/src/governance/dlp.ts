import axios from 'axios';
import { ErrorTypes, isEphemeralAgentId } from 'librechat-data-provider';
import type {
  TPayload,
  TEndpointOption,
  TEphemeralAgent,
  GovernanceDecision,
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceDlpReview,
  GovernanceMaskedContent,
} from 'librechat-data-provider';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
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
import { isGovernancePilotEnabled } from './mode';
import { isEnabled } from '~/utils/common';

const DLP_CHECK_PATH = '/api/v1/dlp/check';
const DLP_CHAT_COMPLETIONS_PATH = '/api/v1/dlp/chat/completions';
/** Completion base paths the gateway serves: `/v1` (check token) and `/api/v1/dlp` (inline DLP). */
const COMPLETION_BASE_PATH = /\/(?:api\/v1\/dlp|v1)$/;
const DLP_TOKEN_HEADER = 'X-DLP-Token';
const LIBRECHAT_USER_HEADER = 'X-LibreChat-User-ID';
const DEFAULT_TIMEOUT_MS = 10000;

const DLP_FAILURE_MESSAGE =
  'The message could not be checked against the data loss prevention policy. Please try again later.';
const DLP_BLOCKED_MESSAGE =
  "This message was blocked by your organization's data loss prevention policy. No content was sent to the model.";
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
  /** `/api/v1/dlp` only: return a review instead of calling the model when DLP finds anything. */
  require_user_approval?: boolean;
  /** `/api/v1/dlp` only: approval token of the stage 1 review being completed. */
  dlp_token?: string;
}

export interface DlpCheckResult extends GovernanceDlpResult {
  dlpToken?: string;
}

export interface DlpBlock {
  status: number;
  body: {
    type: ErrorTypes;
    reason: 'policy_blocked';
    message: string;
    decision: 'BLOCK';
    policy_version?: number;
    findings: GovernanceFinding[];
  };
}

/** Gateway response shape. `decision` is accepted for the contract dependency's future spelling. */
export interface DlpCheckResponse {
  action?: string;
  decision?: string;
  policy_version?: number;
  findings?: GovernanceFinding[];
  masked_preview?: GovernanceMaskedContent[] | null;
  dlp_token?: string;
}

export type HttpPoster = (
  url: string,
  body: GovernanceChatCompletionRequest,
  config: AxiosRequestConfig,
) => Promise<AxiosResponse<DlpCheckResponse>>;

export type GovernanceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DlpChecker = (params: CheckDlpParams) => Promise<DlpCheckResult>;

export interface CheckDlpParams {
  request: GovernanceChatCompletionRequest;
  userId: string;
  http?: HttpPoster;
}

export interface GovernanceFetchParams {
  userId: string;
  fetch?: GovernanceFetch;
  check?: DlpChecker;
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
  return trimTrailingSlash(value).replace(COMPLETION_BASE_PATH, '');
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

function normalizeResponse(response: DlpCheckResponse): DlpCheckResult {
  return {
    decision: normalizeDecision(response.action ?? response.decision),
    policyVersion: response.policy_version,
    findings: response.findings ?? [],
    maskedPreview: response.masked_preview ?? undefined,
    dlpToken:
      typeof response.dlp_token === 'string' && response.dlp_token.length > 0
        ? response.dlp_token
        : undefined,
  };
}

const defaultHttp: HttpPoster = (url, body, config) => axios.post(url, body, config);

/** Calls the Governance Backend without exposing its service credential to browser code. */
export async function checkDlp({
  request,
  userId,
  http = defaultHttp,
}: CheckDlpParams): Promise<DlpCheckResult> {
  const { gatewayUrl, serviceCredential } = getDlpConfiguration();

  let response: AxiosResponse<DlpCheckResponse>;
  try {
    response = await http(`${gatewayUrl}${DLP_CHECK_PATH}`, request, {
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceCredential}`,
        'X-LibreChat-User-ID': userId,
      },
    });
  } catch {
    throw new GovernanceDlpError('dlp_check_failed');
  }

  if (response.status < 200 || response.status >= 300) {
    throw new GovernanceDlpError('dlp_check_failed');
  }

  return normalizeResponse(response.data);
}

/** The message-form request body fields inspected by the server-side DLP preflight. */
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

/** Formats a BLOCK decision for the shared SSE deny path. Only BLOCK denies a completion. */
export function createDlpBlock(result: DlpCheckResult): DlpBlock {
  if (result.decision !== 'BLOCK') {
    throw new GovernanceDlpError('dlp_block_not_applicable');
  }

  return {
    status: 403,
    body: {
      type: ErrorTypes.GOVERNANCE_BLOCKED,
      reason: 'policy_blocked',
      decision: 'BLOCK',
      message: DLP_BLOCKED_MESSAGE,
      policy_version: result.policyVersion,
      findings: result.findings,
    },
  };
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

function isChatCompletionsUrl(input: RequestInfo | URL): boolean {
  return getRequestPathname(input).endsWith('/chat/completions');
}

/** The DLP completions endpoint scans, masks and blocks in the same call, so it needs no token. */
function isDlpChatCompletionsUrl(input: RequestInfo | URL): boolean {
  return getRequestPathname(input).endsWith(DLP_CHAT_COMPLETIONS_PATH);
}

/**
 * The OpenAI Responses API (`/responses`) sends user content in a request shape the Governance
 * Backend does not accept, so it cannot be scanned or issued an `X-DLP-Token` here. Such a
 * request must fail closed rather than reach the model without the outbound DLP check.
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
    (!isGovernancePilotEnabled() || ['system', 'user', 'assistant'].includes(message.role)) &&
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
    (isGovernancePilotEnabled() &&
      Object.entries(value).some(
        ([key, field]) =>
          ['tools', 'tool_choice', 'functions', 'function_call', 'modalities', 'audio'].includes(
            key,
          ) && field != null,
      )) ||
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
  dlpToken?: string,
): RequestInit {
  const requestHeaders =
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(requestHeaders);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(LIBRECHAT_USER_HEADER, userId);
  if (dlpToken !== undefined) {
    headers.set(DLP_TOKEN_HEADER, dlpToken);
  }
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
 * Governance Backend, leaving the response stream untouched. The `/api/v1/dlp` endpoint enforces
 * DLP on that request itself and, with `onReview`, pauses for the user's approval. The `/v1`
 * endpoint first needs an exact check, whose token is bound to the final message list. A governed
 * completion sent through an unsupported request shape (currently the Responses API) is rejected
 * here rather than forwarded without a scan or token.
 */
export function createGovernanceDlpFetch({
  userId,
  fetch = globalThis.fetch,
  check = checkDlp,
  text = '',
  reviewId,
  onReview,
  reviews,
}: GovernanceFetchParams): GovernanceFetch {
  return async (input, init) => {
    if (isGovernancePilotEnabled()) {
      const base = process.env.GOVERNANCE_API_BASE_URL?.replace(/\/+$/, '');
      const destination = new URL(getRequestUrl(input));
      if (!base || destination.href !== new URL(`${base}/chat/completions`).href) {
        throw new GovernanceDlpError('dlp_check_unsupported_request');
      }
    }
    if (isResponsesApiUrl(input)) {
      throw new GovernanceDlpError('dlp_check_unsupported_request', DLP_UNSUPPORTED_MESSAGE);
    }

    if (!isChatCompletionsUrl(input)) {
      return fetch(input, init);
    }

    const body = await getRequestBody(input, init);
    const request = body ? parseChatCompletionRequest(body) : undefined;
    if (!request || (isGovernancePilotEnabled() && request.stream !== true)) {
      throw new GovernanceDlpError('dlp_check_unsupported_request');
    }

    if (isDlpChatCompletionsUrl(input)) {
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
    }

    const result = await check({ request, userId });
    if (result.decision === 'BLOCK') {
      throw new GovernanceDlpError(
        'dlp_check_intervention_required',
        createDlpBlock(result).body.message,
      );
    }

    if (result.dlpToken === undefined) {
      throw new GovernanceDlpError('dlp_check_malformed_response');
    }

    return fetch(input, withGovernanceRequest(input, init, request, userId, result.dlpToken));
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
