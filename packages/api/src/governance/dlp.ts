import axios from 'axios';
import { ErrorTypes } from 'librechat-data-provider';
import type {
  TPayload,
  TEndpointOption,
  TEphemeralAgent,
  AgentModelParameters,
} from 'librechat-data-provider';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { isEnabled } from '~/utils/common';

const DLP_CHECK_PATH = '/api/v1/dlp/check';
const DLP_TOKEN_HEADER = 'X-DLP-Token';
const LIBRECHAT_USER_HEADER = 'X-LibreChat-User-ID';
const DEFAULT_TIMEOUT_MS = 10000;

const DLP_FAILURE_MESSAGE =
  'The message could not be checked against the data loss prevention policy. Please try again later.';
const DLP_BLOCKED_MESSAGE =
  "This message was blocked by your organization's data loss prevention policy. No content was sent to the model.";
const DLP_UNSUPPORTED_MESSAGE =
  'This message could not be checked against your organization\'s data loss prevention policy because the "Use Responses API" option is enabled. Turn it off for this conversation to continue. No content was sent to the model.';

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
}

export interface DlpCheckResult {
  decision: GovernanceDecision;
  policyVersion?: number;
  findings: GovernanceFinding[];
  maskedPreview?: GovernanceMaskedContent[];
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

export type DlpChecker = (params: CheckDlpParams) => Promise<DlpCheckResult>;

export interface CheckDlpParams {
  request: GovernanceChatCompletionRequest;
  userId: string;
  http?: HttpPoster;
}

export interface GovernanceFetchParams {
  userId: string;
  fetch?: typeof globalThis.fetch;
  check?: DlpChecker;
}

export class GovernanceDlpError extends Error {
  code: string;

  constructor(code: string, message = DLP_FAILURE_MESSAGE) {
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
  return trimTrailingSlash(value).replace(/\/v1$/, '');
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

/** True when the submission is a first-turn plain-text message with no tools, files, or edits. */
export function isPlainTextSubmission(body: GovernanceSubmissionBody): boolean {
  return (
    typeof body?.text === 'string' &&
    body.text.trim().length > 0 &&
    body.editedContent == null &&
    body.isContinued !== true &&
    body.isRegenerate !== true &&
    body.addedConvo == null &&
    body.agent_id == null &&
    body.assistant_id == null &&
    (body.files == null || (Array.isArray(body.files) && body.files.length === 0)) &&
    (body.tools == null || (Array.isArray(body.tools) && body.tools.length === 0)) &&
    !hasSelectedTools(body.ephemeralAgent)
  );
}

function readModel(params?: Partial<AgentModelParameters>): string | undefined {
  return params?.model;
}

/** Resolves the model name for the DLP check from the endpoint option, then the raw body. */
export function getModel(body: GovernanceSubmissionBody): string {
  return (
    readModel(body.endpointOption?.model_parameters) ??
    readModel(body.endpointOption?.modelOptions) ??
    (typeof body.model === 'string' ? body.model : undefined) ??
    'unknown'
  );
}

/** Checks the plain text submitted through LibreChat's normal message form. */
export function checkTextSubmission({
  text,
  model,
  userId,
  http,
}: {
  text: string;
  model: string;
  userId: string;
  http?: HttpPoster;
}): Promise<DlpCheckResult> {
  return checkDlp({
    request: {
      model,
      messages: [{ role: 'user', content: text }],
    },
    userId,
    http,
  });
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

export function createDlpFailure(): {
  status: number;
  body: { type: ErrorTypes; message: string };
} {
  return {
    status: 503,
    body: {
      type: ErrorTypes.GOVERNANCE_UNAVAILABLE,
      message: DLP_FAILURE_MESSAGE,
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
  dlpToken: string,
): RequestInit {
  const requestHeaders =
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(requestHeaders);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(LIBRECHAT_USER_HEADER, userId);
  headers.set(DLP_TOKEN_HEADER, dlpToken);
  return { ...init, body: JSON.stringify(request), headers };
}

/**
 * Checks the exact allow-listed text request immediately before it is streamed to the Governance
 * Backend. This gives the gateway a token bound to the final message list while leaving the
 * response stream untouched. A governed completion sent through an unsupported request shape
 * (currently the Responses API) is rejected here rather than forwarded without a scan or token.
 */
export function createGovernanceDlpFetch({
  userId,
  fetch = globalThis.fetch,
  check = checkDlp,
}: GovernanceFetchParams): typeof globalThis.fetch {
  return async (input, init) => {
    if (isResponsesApiUrl(input)) {
      throw new GovernanceDlpError('dlp_check_unsupported_request', DLP_UNSUPPORTED_MESSAGE);
    }

    if (!isChatCompletionsUrl(input)) {
      return fetch(input, init);
    }

    const body = await getRequestBody(input, init);
    const request = body ? parseChatCompletionRequest(body) : undefined;
    if (!request) {
      throw new GovernanceDlpError('dlp_check_unsupported_request');
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
