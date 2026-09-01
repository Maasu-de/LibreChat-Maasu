import axios from 'axios';
import { ErrorTypes } from 'librechat-data-provider';
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
const DLP_INTERVENTION_MESSAGE =
  "This message needs review against your organization's data loss prevention policy before it can be sent.";

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

export interface DlpIntervention {
  status: number;
  body: {
    type: ErrorTypes;
    reason: 'policy_blocked' | 'policy_intervention';
    message: string;
    decision: Exclude<GovernanceDecision, 'ALLOW'>;
    policy_version?: number;
    findings: GovernanceFinding[];
    masked_preview?: GovernanceMaskedContent[];
    dlp_token?: string;
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
    dlpToken: typeof response.dlp_token === 'string' ? response.dlp_token : undefined,
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

/** Formats WARN, MASK, and BLOCK responses for the existing error/intervention path. */
export function createDlpIntervention(result: DlpCheckResult): DlpIntervention {
  if (result.decision === 'ALLOW') {
    throw new GovernanceDlpError('dlp_intervention_not_required');
  }

  const isBlock = result.decision === 'BLOCK';
  return {
    status: isBlock ? 403 : 422,
    body: {
      type: isBlock ? ErrorTypes.GOVERNANCE_BLOCKED : ErrorTypes.GOVERNANCE_INTERVENTION,
      reason: isBlock ? 'policy_blocked' : 'policy_intervention',
      message: isBlock ? DLP_BLOCKED_MESSAGE : DLP_INTERVENTION_MESSAGE,
      decision: result.decision,
      policy_version: result.policyVersion,
      findings: result.findings,
      masked_preview: result.maskedPreview,
      dlp_token: result.dlpToken,
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
      type: ErrorTypes.GOVERNANCE_BLOCKED,
      message: DLP_FAILURE_MESSAGE,
    },
  };
}

/** True when an OpenAI-compatible completion base URL targets the configured gateway. */
export function isGovernanceGatewayUrl(completionBaseUrl: string): boolean {
  return gatewayRoot(completionBaseUrl) === getDlpConfiguration().gatewayUrl;
}

function isChatCompletionsUrl(input: RequestInfo | URL): boolean {
  const rawUrl =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(rawUrl, 'http://localhost').pathname.endsWith('/chat/completions');
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

/**
 * Checks the exact allow-listed text request immediately before it is streamed to the Governance
 * Backend. This gives the gateway a token bound to the final message list while leaving the
 * response stream untouched.
 */
export function createGovernanceDlpFetch({
  userId,
  fetch = globalThis.fetch,
  check = checkDlp,
}: GovernanceFetchParams): typeof globalThis.fetch {
  return async (input, init) => {
    if (!isChatCompletionsUrl(input)) {
      return fetch(input, init);
    }

    const body = await getRequestBody(input, init);
    const request = body ? parseChatCompletionRequest(body) : undefined;
    if (!request) {
      throw new GovernanceDlpError('dlp_check_unsupported_request');
    }

    const result = await check({ request, userId });
    if (result.decision !== 'ALLOW') {
      throw new GovernanceDlpError('dlp_check_intervention_required');
    }

    return fetch(input, withGovernanceRequest(input, init, request, userId, result.dlpToken));
  };
}
