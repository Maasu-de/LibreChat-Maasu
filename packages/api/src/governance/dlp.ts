import { randomUUID } from 'crypto';
import { ErrorTypes, isEphemeralAgentId } from 'librechat-data-provider';
import type {
  TPayload,
  GovernanceTier,
  TEphemeralAgent,
  GovernanceDecision,
  GovernanceDlpReview,
} from 'librechat-data-provider';
import type { GatewayReview, ReviewStore, DlpFileContext } from './review';
import type { FileContext } from '~/files/context';
import type { ServerRequest } from '~/types/http';
import type { GovernanceAgentRequest } from './agents';
import { createGovernanceAgentFetch, agentRequestHeaders } from './agents';
import {
  readReview,
  reviewTtl,
  getReviewStore,
  toClientReview,
  findSubmittedText,
  findingsInFiles,
  findingsInInstructions,
  toModelBlockReview,
  findingsInSubmittedText,
} from './review';
import { isGovernancePilotEnabled, hasGovernanceFileReferences } from './mode';
import { getGovernanceMasking } from './mask';
import { isEnabled } from '~/utils/common';

const DLP_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
/** Base path under which the gateway serves completions and models. */
const GATEWAY_BASE_PATH = /\/v1$/;
const LIBRECHAT_USER_HEADER = 'X-LibreChat-User-ID';
const LIBRECHAT_GROUPS_HEADER = 'X-LibreChat-Group-IDs';

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
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  /** Return a review instead of calling the model when DLP finds anything. */
  require_user_approval?: boolean;
  /** Approval token of the stage 1 review being completed. */
  dlp_token?: string;
  /** Additional user-provided messages newly introduced to this agent run. */
  review_message_indices?: number[];
}

export type GovernanceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GovernanceFetchParams {
  userId: string;
  /** The user's LibreChat group IDs, so the gateway can apply group-scoped policy overrides. */
  groupIds?: string[];
  fetch?: GovernanceFetch;
  /** The user's submitted text, which reviews and approvals are bound to. */
  text?: string;
  /** Review the user approved; its stored request is sent instead of the rebuilt one. */
  reviewId?: string;
  /** The attached-document blocks this turn added to messages. */
  fileContexts?: () => DlpFileContext[];
  /** Receives a review the user has to decide on. The model call then ends without a completion. */
  onReview?: (review: GovernanceDlpReview) => void;
  /** Called when the gateway starts a completion, which means the request passed DLP. */
  onSent?: () => void;
  /** Told after each send of the approved review whether a failure put it back for another try. */
  onApprovalKept?: (kept: boolean) => void;
  reviews?: ReviewStore;
  /** Server-owned saved-agent context, which enables the agent parameter allowlist. */
  agentRequest?: (init?: RequestInit) => GovernanceAgentRequest | undefined;
  onAgentApproval?: (context: GovernanceAgentRequest) => void;
  reviewedInstructions?: Set<string>;
  conversationCreatedAt?: () => string | undefined;
}

/** Raised when the DLP integration cannot be set up. A rejected completion is a 400 instead. */
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
    throw new GovernanceDlpError('dlp_not_configured');
  }

  return { gatewayUrl, serviceCredential };
}

function normalizeDecision(value: string | undefined): GovernanceDecision | undefined {
  const decision = value?.toUpperCase();
  if (decision === 'ALLOW' || decision === 'WARN' || decision === 'MASK' || decision === 'BLOCK') {
    return decision;
  }
  return undefined;
}

/** The message-form request body fields that decide whether a send takes the DLP approval flow. */
export type GovernanceSubmissionBody = Partial<
  Pick<
    TPayload,
    | 'text'
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
>;

/** True when the ephemeral agent has any tool selected that would bypass a plain-text send. */
export function hasSelectedTools(ephemeralAgent?: TEphemeralAgent | null): boolean {
  return (
    (Array.isArray(ephemeralAgent?.mcp) && ephemeralAgent.mcp.length > 0) ||
    ephemeralAgent?.web_search === true ||
    ephemeralAgent?.file_search === true ||
    ephemeralAgent?.execute_code === true
  );
}

/** True for a nonempty text submission, including enabled attachments and ephemeral-agent follow-ups. */
export function isPlainTextSubmission(body: GovernanceSubmissionBody): boolean {
  const hasFiles = hasGovernanceFileReferences(body?.files);
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
    (body.files == null || (Array.isArray(body.files) && body.files.length === 0) || hasFiles) &&
    (body.tools == null || (Array.isArray(body.tools) && body.tools.length === 0)) &&
    !hasSelectedTools(body.ephemeralAgent)
  );
}

/** True when an OpenAI-compatible completion base URL targets the configured gateway. */
export function isGovernanceGatewayUrl(completionBaseUrl: string): boolean {
  const configuredGatewayUrl = gatewayRoot(process.env.GOVERNANCE_API_BASE_URL ?? '');
  if (!configuredGatewayUrl || gatewayRoot(completionBaseUrl) !== configuredGatewayUrl) {
    // Endpoint initializers call this for every configured endpoint. A deployment without the
    // governance integration, or an unrelated endpoint, must be left untouched.
    return false;
  }

  // A matching gateway with DLP enabled must be fully configured. Do not turn a missing service
  // credential into an ordinary, ungoverned completion path.
  if (isGovernanceDlpEnabled()) {
    getDlpConfiguration();
  }

  return true;
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
 * Backend does not accept, so it cannot be scanned. Such a request is rejected rather than sent on
 * without DLP enforcement.
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

function parseChatCompletionRequest(
  body: string,
  agentParameters: boolean,
): GovernanceChatCompletionRequest | undefined {
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
    top_p?: unknown;
    frequency_penalty?: unknown;
    presence_penalty?: unknown;
    max_tokens?: unknown;
    max_completion_tokens?: unknown;
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

  const normalizedRequest: GovernanceChatCompletionRequest = {
    model: request.model,
    messages: request.messages,
    ...(typeof request.stream === 'boolean' ? { stream: request.stream } : {}),
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
  };
  if (!agentParameters) {
    return normalizedRequest;
  }
  if (
    request.max_tokens !== undefined &&
    request.max_completion_tokens !== undefined &&
    request.max_tokens !== request.max_completion_tokens
  ) {
    return undefined;
  }

  const parameters: Pick<
    GovernanceChatCompletionRequest,
    'top_p' | 'frequency_penalty' | 'presence_penalty' | 'max_tokens'
  > = {};
  for (const [key, min, max, integer] of [
    ['top_p', 0, 1, false],
    ['frequency_penalty', -2, 2, false],
    ['presence_penalty', -2, 2, false],
    ['max_tokens', 1, Infinity, true],
  ] as const) {
    const parameter =
      key === 'max_tokens' && request.max_tokens === undefined
        ? request.max_completion_tokens
        : request[key];
    if (parameter === undefined) continue;
    if (
      typeof parameter !== 'number' ||
      !Number.isFinite(parameter) ||
      parameter < min ||
      parameter > max ||
      (integer && !Number.isInteger(parameter))
    ) {
      return undefined;
    }
    parameters[key] = parameter;
  }

  return { ...normalizedRequest, ...parameters };
}

function withGovernanceRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  request: GovernanceChatCompletionRequest,
  userId: string,
  groupIds: string[],
): RequestInit {
  return {
    ...withGovernanceHeaders(input, init, userId, groupIds),
    body: JSON.stringify(request),
  };
}

function withGovernanceHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  userId: string,
  groupIds: string[],
): RequestInit {
  const requestHeaders =
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(requestHeaders);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(LIBRECHAT_USER_HEADER, userId);
  headers.set(LIBRECHAT_GROUPS_HEADER, JSON.stringify(groupIds));
  return { ...init, headers };
}

type DlpRejectionCode =
  | 'dlp_review_required'
  | 'dlp_approval_invalid'
  | 'dlp_malformed_response'
  | 'dlp_unsupported_request';

/**
 * Ends the model call with a 400 that carries the reason. Every rejection is returned this way
 * and never thrown: the SDK retries a thrown fetch error and then reports it as a connection
 * error, which hides the message.
 */
function rejectCompletion(code: DlpRejectionCode, message: string = DLP_FAILURE_MESSAGE): Response {
  return new Response(JSON.stringify({ error: { message, type: 'governance_dlp_error', code } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ApprovalParams {
  input: RequestInfo | URL;
  init?: RequestInit;
  request: GovernanceChatCompletionRequest;
  userId: string;
  groupIds: string[];
  text: string;
  reviewId?: string;
  fileContexts: () => DlpFileContext[];
  onReview: (review: GovernanceDlpReview) => void;
  onApprovalKept?: (kept: boolean) => void;
  fetch: GovernanceFetch;
  reviews: ReviewStore;
  agentRequest?: (init?: RequestInit) => GovernanceAgentRequest | undefined;
  onAgentApproval?: (context: GovernanceAgentRequest) => void;
  conversationCreatedAt?: () => string | undefined;
}

function withApproval(
  { input, init, request, userId, groupIds }: ApprovalParams,
  messages: GovernanceChatMessage[],
  dlpToken?: string,
): RequestInit {
  const approval: GovernanceChatCompletionRequest = {
    ...request,
    messages,
    require_user_approval: true,
    ...(dlpToken !== undefined ? { dlp_token: dlpToken, review_message_indices: undefined } : {}),
  };
  return withGovernanceRequest(input, init, approval, userId, groupIds);
}

/**
 * Handles a stage 1 review: it is stored for the user's approval and handed to `onReview`, and
 * the model call ends. Findings in the submitted text, attached files, and newly introduced
 * agent instructions are shown separately. Approval sends the gateway's exact masked messages.
 */
async function handleReview(params: ApprovalParams, review: GatewayReview): Promise<Response> {
  const decision = normalizeDecision(review.action);
  if (!decision) {
    return rejectCompletion('dlp_malformed_response');
  }
  const fileContexts = params.fileContexts();
  const submitted = findSubmittedText(params.request.messages, params.text);
  if (!submitted) {
    return rejectCompletion('dlp_unsupported_request');
  }

  const findings = findingsInSubmittedText(review.findings ?? [], submitted);
  const fileFindings = findingsInFiles(
    params.request.messages,
    review.findings ?? [],
    submitted,
    fileContexts,
  );
  const masking = getGovernanceMasking(params.text, findings);
  const instructions = findingsInInstructions(
    params.request.messages,
    review.findings ?? [],
    params.request.review_message_indices,
  );
  if (decision === 'BLOCK') {
    params.onReview(
      review.block_reason === 'model_not_allowed'
        ? toModelBlockReview(review, params.request.model, findings, fileFindings, instructions)
        : toClientReview(review, decision, findings, masking, fileFindings, instructions),
    );
    return rejectCompletion('dlp_review_required', DLP_REVIEW_PENDING_MESSAGE);
  }

  const { messages, dlp_token: dlpToken } = review;
  if (!messages || !dlpToken) {
    return rejectCompletion('dlp_malformed_response');
  }
  if (findings.length === 0 && fileFindings.length === 0 && instructions.length === 0) {
    return rejectCompletion('dlp_malformed_response');
  }

  const { text: approvedText } = masking;
  if (!messages[submitted.messageIndex]?.content.endsWith(approvedText)) {
    return rejectCompletion('dlp_malformed_response');
  }
  for (const index of params.request.review_message_indices ?? []) {
    const message = params.request.messages[index];
    const instructionFindings = (review.findings ?? []).filter(
      (finding) => finding.location === `/messages/${index}/content`,
    );
    const masked = getGovernanceMasking(message.content, instructionFindings).text;
    if (messages[index]?.role !== message.role || messages[index]?.content !== masked) {
      return rejectCompletion('dlp_malformed_response');
    }
  }

  await params.reviews.set(
    review.review_id,
    {
      userId: params.userId,
      model: params.request.model,
      text: approvedText,
      messages,
      dlpToken,
      expiresAt: review.expires_at,
      agentRequest: params.agentRequest?.(params.init),
      ...(params.agentRequest?.(params.init)
        ? {
            instructionMessages: systemInstructions(params.request.messages),
            conversationCreatedAt: params.conversationCreatedAt?.(),
          }
        : {}),
    },
    reviewTtl(review.expires_at),
  );
  params.onReview(toClientReview(review, decision, findings, masking, fileFindings, instructions));
  return rejectCompletion('dlp_review_required', DLP_REVIEW_PENDING_MESSAGE);
}

/** A failed send worth repeating: a timeout, a rate limit or a server error. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Sends the approved stage 2 request. The review is claimed before it is sent, so concurrent
 * confirmations cannot both send it. It is restored when the send fails in a way that can be
 * retried, by the SDK or by the user, and not when the gateway rejects the approval itself.
 */
async function sendApproved(params: ApprovalParams, reviewId: string): Promise<Response> {
  const { request, userId, text, reviews, onApprovalKept } = params;
  const stored = await reviews.get(reviewId);
  if (
    !stored ||
    stored.userId !== userId ||
    stored.model !== request.model ||
    stored.text !== text ||
    (stored.instructionMessages !== undefined &&
      JSON.stringify(stored.instructionMessages) !==
        JSON.stringify(systemInstructions(request.messages))) ||
    stored.agentRequest?.agentId !== params.agentRequest?.(params.init)?.agentId ||
    !(await reviews.delete(reviewId))
  ) {
    return rejectCompletion('dlp_approval_invalid', DLP_APPROVAL_INVALID_MESSAGE);
  }

  onApprovalKept?.(false);
  if (stored.agentRequest) {
    params.onAgentApproval?.(stored.agentRequest);
    const headers = new Headers(params.init?.headers);
    for (const [key, value] of Object.entries(agentRequestHeaders(stored.agentRequest))) {
      headers.set(key, value);
    }
    params = { ...params, init: { ...params.init, headers } };
  }
  const restore = async () => {
    await reviews.set(reviewId, stored, reviewTtl(stored.expiresAt));
    onApprovalKept?.(true);
  };
  let approved: Response;
  try {
    approved = await params.fetch(
      params.input,
      withApproval(params, stored.messages, stored.dlpToken),
    );
  } catch (error) {
    await restore();
    throw error;
  }
  if (!approved.ok && isRetryableStatus(approved.status)) {
    await restore();
  }
  return approved;
}

/** Sends the approved stage 2 request, or stage 1 with `require_user_approval`. */
async function sendForApproval(params: ApprovalParams): Promise<Response> {
  const { input, request, reviewId } = params;
  if (reviewId !== undefined) {
    return sendApproved(params, reviewId);
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
  groupIds = [],
  fetch = globalThis.fetch,
  text = '',
  reviewId,
  fileContexts = () => [],
  onReview,
  onSent,
  onApprovalKept,
  reviews,
  agentRequest,
  onAgentApproval,
  reviewedInstructions = new Set<string>(),
  conversationCreatedAt,
}: GovernanceFetchParams): GovernanceFetch {
  let pendingReviewId = reviewId;
  return async (input, init) => {
    if (isGovernancePilotEnabled()) {
      const base = process.env.GOVERNANCE_API_BASE_URL?.replace(/\/+$/, '');
      const destination = new URL(getRequestUrl(input));
      if (!base || destination.href !== new URL(`${base}/chat/completions`).href) {
        return rejectCompletion('dlp_unsupported_request');
      }
    }
    if (isResponsesApiUrl(input)) {
      return rejectCompletion('dlp_unsupported_request', DLP_UNSUPPORTED_MESSAGE);
    }

    if (!isDlpChatCompletionsUrl(input)) {
      return fetch(input, init);
    }

    const body = await getRequestBody(input, init);
    const request = body
      ? parseChatCompletionRequest(body, agentRequest?.(init) !== undefined)
      : undefined;
    // Non-streaming requests (LibreChat's conversation title) are allowed: the
    // Governance Backend serves both forms through the same governed path.
    if (!request) {
      return rejectCompletion('dlp_unsupported_request');
    }
    if (onReview && agentRequest?.(init)) {
      const indices = request.messages.flatMap((message, index) =>
        message.role === 'system' && !reviewedInstructions.has(message.content) ? [index] : [],
      );
      if (indices.length > 0) {
        request.review_message_indices = indices;
      }
    }

    const response = onReview
      ? await sendForApproval({
          input,
          init,
          request,
          userId,
          groupIds,
          text,
          reviewId: pendingReviewId,
          fileContexts,
          onReview,
          onApprovalKept,
          fetch,
          reviews: reviews ?? getReviewStore(),
          agentRequest,
          onAgentApproval,
          conversationCreatedAt,
        })
      : await fetch(input, withGovernanceRequest(input, init, request, userId, groupIds));
    if (response.ok) {
      if (agentRequest?.(init)) {
        pendingReviewId = undefined;
        if (onReview) {
          for (const instruction of systemInstructions(request.messages)) {
            reviewedInstructions.add(instruction);
          }
        }
      }
      onSent?.();
    }
    return response;
  };
}

function systemInstructions(messages: GovernanceChatMessage[]): string[] {
  return messages.filter((message) => message.role === 'system').map((message) => message.content);
}

/** The gateway's 403 for a selected model that the content does not allow. */
interface ModelNotAllowedBody {
  error?: { code?: string; allowed_tiers?: GovernanceTier[] };
}

/**
 * Restates the gateway's rejection of a model the content does not allow as a typed error, so the
 * chat explains it in the user's language with the allowed tiers. The SDK puts the message in the
 * error it throws, so the type travels as that message.
 */
async function explainModelRejection(response: Response): Promise<Response> {
  if (response.status !== 403) {
    return response;
  }
  const body: ModelNotAllowedBody | undefined = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (body?.error?.code !== ErrorTypes.GOVERNANCE_MODEL_NOT_ALLOWED) {
    return response;
  }
  const info = (body.error.allowed_tiers ?? []).map((tier) => tier.name).join(', ');
  const message = JSON.stringify({ type: ErrorTypes.GOVERNANCE_MODEL_NOT_ALLOWED, info });
  return new Response(JSON.stringify({ error: { ...body.error, message } }), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Adds server-resolved identity and group context to every gateway request. This deliberately
 * does not perform DLP parsing or approval, so completions that the DLP flow cannot govern
 * (files, tools, regenerations, and DLP-disabled deployments) still have accurate usage
 * attribution at the gateway. A rejected model is explained on every one of these paths.
 */
export function createGovernanceAttributionFetch(
  req: ServerRequest,
  fetch: GovernanceFetch = globalThis.fetch,
): GovernanceFetch {
  return async (input, init) =>
    explainModelRejection(
      await fetch(
        input,
        withGovernanceHeaders(input, init, req.user?.id ?? '', req.governanceGroupIds ?? []),
      ),
    );
}

function markDlpSent(req: ServerRequest): void {
  if (req.governanceDlpSent === true) {
    return;
  }
  req.governanceDlpSent = true;
  const callbacks = req.governanceDlpSentCallbacks ?? [];
  req.governanceDlpSentCallbacks = undefined;
  for (const callback of callbacks) {
    callback();
  }
}

/** True for a governed turn whose completion the gateway has not started: it stores nothing. */
export function isDlpUnsent(req?: ServerRequest): boolean {
  return req?.governanceDlpSent === false;
}

/**
 * The approved review of an unsent turn whose send failed but put the review back, so the user
 * can send it again. Undefined for any other turn.
 */
export function getRetryableDlpReviewId(req?: ServerRequest): string | undefined {
  const reviewId = req?.body?.dlpReviewId;
  if (!isDlpUnsent(req) || req?.governanceDlpApprovalKept !== true) {
    return undefined;
  }
  return typeof reviewId === 'string' && reviewId !== '' ? reviewId : undefined;
}

/** Records an attached-document block added to this turn's submitted message or its history. */
export function addDlpFileContext(
  req: ServerRequest | undefined,
  fileContext: FileContext,
  current: boolean,
): void {
  if (req) {
    req.governanceDlpFileContexts = [
      ...(req.governanceDlpFileContexts ?? []),
      { ...fileContext, current },
    ];
  }
}

/** Runs `callback` once the gateway starts this turn's completion, or at once if not governed. */
export function onDlpSent(req: ServerRequest | undefined, callback: () => void): void {
  if (!req || !isDlpUnsent(req)) {
    callback();
    return;
  }
  req.governanceDlpSentCallbacks = [...(req.governanceDlpSentCallbacks ?? []), callback];
}

/** The approval-off fetch of each turn's governed fetch, for side calls made with its options. */
const sideCallFetches = new WeakMap<GovernanceFetch, GovernanceFetch>();

/**
 * The governed fetch for one chat request. The turn counts as unsent until the gateway starts its
 * completion, and a review the user has to decide on is set on `req`. Without `approval`, as for a
 * title, the gateway masks or blocks the call itself and the turn's state is left untouched.
 */
export function createRequestDlpFetch(
  req: ServerRequest,
  fetch?: GovernanceFetch,
  approval: boolean = true,
): GovernanceFetch {
  const agentRequest = (init?: RequestInit): GovernanceAgentRequest | undefined => {
    const context = req.governanceAgentRequest;
    if (!context) return undefined;
    const headers = new Headers(init?.headers);
    return {
      ...context,
      runId: headers.get('X-LibreChat-Run-ID') ?? context.runId,
      stepId: headers.get('X-LibreChat-Step-ID') ?? context.stepId,
      requestId: headers.get('X-LibreChat-Request-ID') ?? context.requestId,
    };
  };
  if (!approval) {
    return createGovernanceAgentFetch(
      req,
      createGovernanceDlpFetch({
        userId: req.user?.id ?? '',
        groupIds: req.governanceGroupIds,
        fetch,
        agentRequest,
      }),
    );
  }
  const { text, dlpReviewId } = req.body ?? {};
  req.governanceDlpSent ??= false;
  const governedFetch = createGovernanceAgentFetch(
    req,
    createGovernanceDlpFetch({
      userId: req.user?.id ?? '',
      groupIds: req.governanceGroupIds,
      fetch,
      text: typeof text === 'string' ? text : '',
      reviewId: typeof dlpReviewId === 'string' && dlpReviewId !== '' ? dlpReviewId : undefined,
      agentRequest,
      reviewedInstructions: (req.governanceDlpReviewedInstructions ??= new Set<string>()),
      conversationCreatedAt: () => req.conversationCreatedAt,
      onAgentApproval: (context) => {
        if (req.governanceAgentRun) {
          Object.assign(req.governanceAgentRun, context);
        }
        req.governanceAgentRequest = context;
      },
      fileContexts: () => req.governanceDlpFileContexts ?? [],
      onReview: (review) => {
        req.governanceDlpReview = review;
      },
      onSent: () => markDlpSent(req),
      onApprovalKept: (kept) => {
        req.governanceDlpApprovalKept = kept;
      },
    }),
  );
  sideCallFetches.set(governedFetch, createRequestDlpFetch(req, fetch, false));
  return governedFetch;
}

export async function prepareGovernanceAgentRun(req: ServerRequest): Promise<void> {
  if (
    !isGovernancePilotEnabled() ||
    !req.body.agent_id ||
    isEphemeralAgentId(req.body.agent_id) ||
    req.governanceAgentRun
  ) {
    return;
  }
  const review = req.body.dlpReviewId
    ? await getReviewStore().get(req.body.dlpReviewId)
    : undefined;
  const previous =
    review?.userId === req.user?.id && review?.agentRequest?.agentId === req.body.agent_id
      ? review.agentRequest
      : undefined;
  if (previous && review?.conversationCreatedAt) {
    req.conversationCreatedAt = review.conversationCreatedAt;
  }
  req.governanceAgentRun = previous
    ? { agentId: previous.agentId, runId: previous.runId, steps: 0 }
    : { agentId: req.body.agent_id, runId: randomUUID(), steps: 0 };
}

/**
 * The approval-off fetch for a side call, such as a summarization, that reuses a turn's governed
 * client options. Unlike the turn's own fetch, its completion does not mark the turn as sent.
 */
export function getDlpSideCallFetch(fetch?: GovernanceFetch): GovernanceFetch | undefined {
  return fetch ? sideCallFetches.get(fetch) : undefined;
}
