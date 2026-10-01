import { CacheKeys, GOVERNANCE_DLP_TEXT_LOCATION } from 'librechat-data-provider';
import type {
  GovernanceFinding,
  GovernanceDecision,
  GovernanceDlpReview,
} from 'librechat-data-provider';
import type { FinalEvent, FinalMessageFields } from '~/types/events';
import type { GovernanceChatMessage } from './dlp';
import { standardCache } from '~/cache';

const DEFAULT_REVIEW_TTL_MS = 10 * 60 * 1000;
const EVENT_END = /\r?\n\r?\n/;

/** The `dlp` extension of a stage 1 response from `POST /api/v1/dlp/chat/completions`. */
export interface GatewayReview {
  review_id: string;
  action: string;
  policy_version?: number;
  findings?: GovernanceFinding[];
  messages?: GovernanceChatMessage[];
  dlp_token?: string;
  expires_at?: number;
}

/** A review the user can still approve: the exact stage 2 request, bound to its user and text. */
export interface StoredReview {
  userId: string;
  model: string;
  text: string;
  messages: GovernanceChatMessage[];
  dlpToken: string;
  /** Unix seconds at which the gateway's approval token expires. */
  expiresAt?: number;
}

export interface ReviewStore {
  get: (reviewId: string) => Promise<StoredReview | undefined>;
  set: (reviewId: string, review: StoredReview, ttl: number) => Promise<unknown>;
  /** Resolves true only for the caller that removed the review, even when called concurrently. */
  delete: (reviewId: string) => Promise<boolean>;
}

/** Where the user's submitted text sits in the chat request LibreChat sends to the gateway. */
export interface SubmittedText {
  messageIndex: number;
  /** Code-point offset of the submitted text within that message, after any quoted excerpts. */
  offset: number;
}

let reviewStore: ReviewStore | undefined;

/** Reviews live in the shared cache so a confirmation can reach any server instance. */
export function getReviewStore(): ReviewStore {
  reviewStore ??= standardCache(CacheKeys.GOVERNANCE_DLP_REVIEWS) as ReviewStore;
  return reviewStore;
}

export function reviewTtl(expiresAt: number | undefined, now: number = Date.now()): number {
  if (expiresAt === undefined) {
    return DEFAULT_REVIEW_TTL_MS;
  }
  return Math.max(expiresAt * 1000 - now, 1000);
}

function readReviewField(value: unknown): GatewayReview | undefined {
  if (typeof value !== 'object' || value === null || !('dlp' in value)) {
    return undefined;
  }
  const review = (value as { dlp?: GatewayReview }).dlp;
  return typeof review?.review_id === 'string' ? review : undefined;
}

function parseEventData(event: string): unknown {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * Reads a streamed response up to the end of its first server-sent event, which tells a review
 * from a completion, and returns a response that replays everything read.
 */
async function readFirstEvent(response: Response): Promise<{ event: string; response: Response }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { event: '', response };
  }

  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let text = '';
  let done = false;
  while (!done && !EVENT_END.test(text)) {
    const result = await reader.read();
    done = result.done;
    if (result.value) {
      chunks.push(result.value);
      text += decoder.decode(result.value, { stream: true });
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      if (done) {
        controller.close();
      }
    },
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const replay = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return { event: text.split(EVENT_END)[0], response: replay };
}

/** Returns the review in a stage 1 response, and the response to pass on when it is a completion. */
export async function readReview(
  response: Response,
): Promise<{ review?: GatewayReview; response: Response }> {
  if (!response.ok) {
    return { response };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body: unknown = await response.clone().json();
    return { review: readReviewField(body), response };
  }
  if (!contentType.includes('text/event-stream')) {
    return { response };
  }

  const first = await readFirstEvent(response);
  return { review: readReviewField(parseEventData(first.event)), response: first.response };
}

/** Finds the last user message that ends with the submitted text; quoted excerpts precede it. */
export function findSubmittedText(
  messages: GovernanceChatMessage[],
  text: string,
): SubmittedText | undefined {
  if (text.length === 0) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i];
    if (role === 'user' && content.endsWith(text)) {
      return {
        messageIndex: i,
        offset: Array.from(content).length - Array.from(text).length,
      };
    }
  }
  return undefined;
}

/** Findings inside the submitted text, with offsets relative to that text. */
export function findingsInSubmittedText(
  findings: GovernanceFinding[],
  { messageIndex, offset }: SubmittedText,
): GovernanceFinding[] {
  const location = `/messages/${messageIndex}/content`;
  return findings
    .filter((finding) => finding.location === location && finding.end > offset)
    .map((finding) => ({
      ...finding,
      location: GOVERNANCE_DLP_TEXT_LOCATION,
      start: Math.max(finding.start - offset, 0),
      end: finding.end - offset,
    }));
}

/** Applies each finding's replacement to the text, using code-point offsets like the gateway. */
export function maskText(text: string, findings: GovernanceFinding[]): string {
  const chars = Array.from(text);
  const masks = findings
    .filter((finding) => finding.replacement !== undefined)
    .sort((a, b) => a.start - b.start);

  let masked = '';
  let cursor = 0;
  for (const { start, end, replacement } of masks) {
    if (start < cursor) {
      continue;
    }
    masked += chars.slice(cursor, start).join('') + replacement;
    cursor = end;
  }
  return masked + chars.slice(cursor).join('');
}

/**
 * Ends a turn paused for DLP review the way an early abort ends it: nothing was saved, so the
 * client drops the pending messages, restores the draft and shows the review.
 */
export function createReviewEvent(
  review: GovernanceDlpReview,
  userMessage?: FinalMessageFields & { quotes?: string[] },
): FinalEvent {
  return {
    final: true,
    conversation: null,
    title: 'New Chat',
    requestMessage: userMessage
      ? {
          messageId: userMessage.messageId,
          parentMessageId: userMessage.parentMessageId,
          conversationId: userMessage.conversationId,
          text: userMessage.text ?? '',
          quotes: userMessage.quotes,
          isCreatedByUser: true,
        }
      : null,
    responseMessage: null,
    aborted: true,
    earlyAbort: true,
    dlpReview: review,
  };
}

export function toClientReview(
  review: GatewayReview,
  decision: GovernanceDecision,
  findings: GovernanceFinding[],
  approvedText?: string,
): GovernanceDlpReview {
  return {
    reviewId: review.review_id,
    decision,
    policyVersion: review.policy_version,
    findings,
    maskedPreview:
      approvedText === undefined
        ? undefined
        : [{ location: GOVERNANCE_DLP_TEXT_LOCATION, text: approvedText }],
    expiresAt: review.expires_at,
  };
}
