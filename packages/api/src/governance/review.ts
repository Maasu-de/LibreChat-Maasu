import { CacheKeys, GOVERNANCE_DLP_TEXT_LOCATION } from 'librechat-data-provider';
import type {
  GovernanceFinding,
  GovernanceDecision,
  GovernanceDlpReview,
  GovernanceMaskedSpan,
  GovernanceFileFinding,
} from 'librechat-data-provider';
import type { FinalEvent, FinalMessageFields } from '~/types/events';
import type { FileContext } from '~/files/context';
import type { GovernanceChatMessage } from './dlp';
import type { GovernanceMasking } from './mask';
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
  /** Where `text` holds the gateway's replacements, kept on the sent message. */
  masks?: GovernanceMaskedSpan[];
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

const MESSAGE_CONTENT_LOCATION = /^\/messages\/(\d+)\/content$/;

/** An attached-document block this turn added to a message; `current` marks the submitted one's. */
export interface DlpFileContext extends FileContext {
  current: boolean;
}

interface LocatedFile {
  fileId?: string;
  filename: string;
  type?: string;
  start: number;
  end: number;
}

/** A user message's code points and the attached files located in it. */
interface MessageFiles {
  chars: string[];
  files: LocatedFile[];
}

/**
 * Places the recorded attached-document blocks found in `content` at their code-point offsets.
 * Only a block's exact text is matched, so text inside a file cannot fake a file boundary. The
 * submitted message is matched against this turn's blocks only, which name their files' IDs.
 */
function locateFiles(
  content: string,
  fileContexts: DlpFileContext[],
  current: boolean,
): LocatedFile[] {
  const located: LocatedFile[] = [];
  for (const fileContext of fileContexts) {
    const index = fileContext.current === current ? content.lastIndexOf(fileContext.text) : -1;
    if (index === -1) {
      continue;
    }
    const base = Array.from(content.slice(0, index)).length;
    for (const { fileId, filename, type, start, end } of fileContext.files) {
      located.push({
        ...(current ? { fileId } : {}),
        filename,
        type,
        start: base + start,
        end: base + end,
      });
    }
  }
  return located;
}

/**
 * Findings inside files attached to user messages, counted per file, category and action, with
 * the distinct values they matched. Findings in the submitted text are left to
 * `findingsInSubmittedText`. A finding in a file attached to the submitted message names that
 * file's ID, since only those can be withdrawn.
 */
export function findingsInFiles(
  messages: GovernanceChatMessage[],
  findings: GovernanceFinding[],
  submitted: SubmittedText,
  fileContexts: DlpFileContext[] = [],
): GovernanceFileFinding[] {
  const filesByMessage = new Map<number, MessageFiles>();
  const counted = new Map<string, { counter: GovernanceFileFinding; terms: Map<string, string> }>();
  for (const finding of findings) {
    const match = MESSAGE_CONTENT_LOCATION.exec(finding.location);
    const messageIndex = match ? Number(match[1]) : -1;
    const message = messages[messageIndex];
    const isSubmitted = messageIndex === submitted.messageIndex;
    if (message?.role !== 'user' || (isSubmitted && finding.end > submitted.offset)) {
      continue;
    }
    let located = filesByMessage.get(messageIndex);
    if (!located) {
      const chars = Array.from(message.content);
      const content = isSubmitted ? chars.slice(0, submitted.offset).join('') : message.content;
      located = { chars, files: locateFiles(content, fileContexts, isSubmitted) };
      filesByMessage.set(messageIndex, located);
    }
    const file = located.files.find(
      ({ start, end }) => finding.start >= start && finding.start < end,
    );
    if (!file) {
      continue;
    }
    const term = located.chars.slice(finding.start, finding.end).join('');
    const { fileId, filename, type } = file;
    const key = JSON.stringify([fileId ?? null, filename, finding.category, finding.action]);
    const entry = counted.get(key);
    if (entry) {
      entry.counter.count += 1;
      addTerm(entry.terms, term);
      continue;
    }
    const counter: GovernanceFileFinding = {
      filename,
      category: finding.category,
      action: finding.action,
      count: 1,
    };
    if (fileId !== undefined) {
      counter.fileId = fileId;
    }
    if (finding.label !== undefined) {
      counter.label = finding.label;
    }
    if (type !== undefined) {
      counter.type = type;
    }
    const terms = new Map<string, string>();
    addTerm(terms, term);
    counted.set(key, { counter, terms });
  }
  return Array.from(counted.values(), ({ counter, terms }) => ({
    ...counter,
    terms: [...terms.values()],
  }));
}

/** Adds a matched value unless one that differs only in case or spacing is listed already. */
function addTerm(terms: Map<string, string>, term: string): void {
  const key = term.replace(/\s+/g, ' ').trim().toLowerCase();
  if (key && !terms.has(key)) {
    terms.set(key, term);
  }
}

type ReviewedUserMessage = FinalMessageFields & { quotes?: string[]; manualSkills?: string[] };

/**
 * Ends a turn paused for DLP review the way an early abort ends it: nothing was saved, so the
 * client drops the pending messages, restores the draft and shows the review.
 */
export function createReviewEvent(
  review: GovernanceDlpReview,
  userMessage?: ReviewedUserMessage,
): FinalEvent {
  return { ...createUnsentTurnEvent(userMessage), dlpReview: review };
}

/**
 * Ends a turn whose approved review could not be sent like a review ends it, so the client
 * shows that review again and the user can send it again or cancel it.
 */
export function createApprovalRetryEvent(
  reviewId: string,
  userMessage?: ReviewedUserMessage,
): FinalEvent {
  return { ...createUnsentTurnEvent(userMessage), dlpRetryReviewId: reviewId };
}

function createUnsentTurnEvent(userMessage?: ReviewedUserMessage): FinalEvent {
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
          manualSkills: userMessage.manualSkills,
          isCreatedByUser: true,
        }
      : null,
    responseMessage: null,
    aborted: true,
    earlyAbort: true,
  };
}

/**
 * The review the user decides on, with where the gateway masks the submitted text. Every
 * decision but BLOCK can be approved, so it also gives the masked text an approval sends.
 */
export function toClientReview(
  review: GatewayReview,
  decision: GovernanceDecision,
  findings: GovernanceFinding[],
  { text, masks, ranges }: GovernanceMasking,
  fileFindings: GovernanceFileFinding[] = [],
): GovernanceDlpReview {
  return {
    reviewId: review.review_id,
    decision,
    policyVersion: review.policy_version,
    findings,
    maskedRanges: ranges.length > 0 ? ranges : undefined,
    fileFindings: fileFindings.length > 0 ? fileFindings : undefined,
    maskedPreview:
      decision === 'BLOCK'
        ? undefined
        : [{ location: GOVERNANCE_DLP_TEXT_LOCATION, text, ...(masks.length > 0 && { masks }) }],
    expiresAt: review.expires_at,
  };
}
