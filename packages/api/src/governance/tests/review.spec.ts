import type { GovernanceDlpReview, GovernanceFinding } from 'librechat-data-provider';
import type { GatewayReview, ReviewStore, StoredReview, DlpFileContext } from '../review';
import type { GovernanceChatMessage } from '../dlp';
import {
  maskText,
  readReview,
  createReviewEvent,
  findingsInFiles,
  findSubmittedText,
  findingsInSubmittedText,
  createApprovalRetryEvent,
} from '../review';
import { createGovernanceDlpFetch } from '../dlp';

const DLP_COMPLETIONS_URL = 'http://governance.test/api/v1/dlp/chat/completions';
const SUBMITTED = 'Please email max@example.com today';
const MASKED = 'Please email [EMAIL] today';

const IBAN = 'DE89370400440532013000';
const ATTACHED = [
  'Attached document(s):\n```md# "report.pdf"\n',
  `Pay ${IBAN} or ${IBAN}\n`,
  '\n\n---\n\n# "notes.txt"\n',
  'mail max@example.com\n',
  '\n```',
].join('');
const WITH_FILES = `${ATTACHED}\n${SUBMITTED}`;

/** The block of `ATTACHED`, as `buildFileContext` records it, for files with the given IDs. */
const attachedContext = (
  current: boolean,
  [reportId, notesId] = ['file-report', 'file-notes'],
  text = ATTACHED,
): DlpFileContext => ({
  text,
  current,
  files: [
    {
      fileId: reportId,
      filename: 'report.pdf',
      start: text.indexOf('# "'),
      end: text.indexOf('\n\n---'),
    },
    {
      fileId: notesId,
      filename: text.includes('"notes.txt"') ? 'notes.txt' : 'report.pdf',
      start: text.lastIndexOf('# "'),
      end: text.lastIndexOf('\n```') + 1,
    },
  ],
});

const ibanFinding = (location: string, start: number): GovernanceFinding => ({
  location,
  start,
  end: start + IBAN.length,
  category: 'IBAN_CODE',
  action: 'MASK',
  replacement: '[IBAN]',
});

const emailFinding = (location: string, start: number): GovernanceFinding => ({
  location,
  start,
  end: start + 'max@example.com'.length,
  category: 'EMAIL_ADDRESS',
  action: 'MASK',
  replacement: '[EMAIL]',
});

const sseResponse = (...events: string[]): Response =>
  new Response(events.map((event) => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });

const reviewResponse = (dlp: GatewayReview): Response =>
  sseResponse(
    JSON.stringify({ id: 'dlprev-1', object: 'chat.completion.chunk', choices: [], dlp }),
    '[DONE]',
  );

const completionResponse = (): Response =>
  sseResponse(
    JSON.stringify({ object: 'chat.completion.chunk', choices: [{ delta: { content: 'Hi' } }] }),
    '[DONE]',
  );

function memoryStore(): ReviewStore & { entries: Map<string, StoredReview> } {
  const entries = new Map<string, StoredReview>();
  return {
    entries,
    get: async (reviewId) => entries.get(reviewId),
    set: async (reviewId, review) => entries.set(reviewId, review),
    delete: async (reviewId) => entries.delete(reviewId),
  };
}

function setup({
  responses,
  text = SUBMITTED,
  reviewId,
  fileContexts,
  reviews = memoryStore(),
}: {
  responses: Response[];
  text?: string;
  reviewId?: string;
  fileContexts?: DlpFileContext[];
  reviews?: ReturnType<typeof memoryStore>;
}) {
  const upstream = jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const response = responses.shift();
      if (!response) {
        throw new Error('unexpected gateway call');
      }
      return response;
    },
  );
  const onReview = jest.fn<void, [GovernanceDlpReview]>();
  const onSent = jest.fn();
  const onApprovalKept = jest.fn<void, [boolean]>();
  const governedFetch = createGovernanceDlpFetch({
    userId: 'user-123',
    fetch: upstream,
    text,
    reviewId,
    fileContexts: fileContexts ? () => fileContexts : undefined,
    onReview,
    onSent,
    onApprovalKept,
    reviews,
  });
  const send = (messages: GovernanceChatMessage[]) =>
    governedFetch(DLP_COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'governed-model', messages, stream: true, top_p: 0.5 }),
    });
  const sentBody = (call: number) => JSON.parse(String(upstream.mock.calls[call]?.[1]?.body));
  return { upstream, onReview, onSent, onApprovalKept, reviews, send, sentBody };
}

describe('readReview', () => {
  it('finds the review in the first server-sent event', async () => {
    const dlp: GatewayReview = { review_id: 'review-1', action: 'MASK' };
    const { review } = await readReview(reviewResponse(dlp));
    expect(review).toEqual(dlp);
  });

  it('replays a streamed completion byte for byte', async () => {
    const original = await completionResponse().text();
    const { review, response } = await readReview(completionResponse());
    expect(review).toBeUndefined();
    expect(await response.text()).toBe(original);
  });

  it('finds the review in a JSON response and leaves the response readable', async () => {
    const response = new Response(
      JSON.stringify({ choices: [], dlp: { review_id: 'r', action: 'WARN' } }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const result = await readReview(response);
    expect(result.review?.review_id).toBe('r');
    expect(await result.response.json()).toMatchObject({ choices: [] });
  });

  it('passes an error response through without reading it', async () => {
    const response = new Response('{"error":{}}', { status: 403 });
    const result = await readReview(response);
    expect(result).toEqual({ response });
  });
});

describe('submitted text helpers', () => {
  it('locates the submitted text after quoted excerpts, in code points', () => {
    const messages = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: `> 🙂 quoted\n\n${SUBMITTED}` },
    ];
    expect(findSubmittedText(messages, SUBMITTED)).toEqual({ messageIndex: 2, offset: 12 });
    expect(findSubmittedText(messages, 'not sent')).toBeUndefined();
  });

  it('keeps only findings inside the submitted text, relative to it', () => {
    const findings = [
      emailFinding('/messages/2/content', 2),
      emailFinding('/messages/2/content', 25),
      emailFinding('/messages/0/content', 0),
    ];
    expect(findingsInSubmittedText(findings, { messageIndex: 2, offset: 20 })).toEqual([
      emailFinding('/messages/0/content', 5),
    ]);
  });

  it('counts findings in attached files per file, category and action', () => {
    const messages = [
      { role: 'user', content: ATTACHED },
      { role: 'assistant', content: `ok ${IBAN}` },
      { role: 'user', content: `> ${IBAN}\n\n${WITH_FILES}` },
    ];
    const quoted = IBAN.length + 4;
    const findings = [
      ibanFinding('/messages/0/content', ATTACHED.indexOf(IBAN)),
      ibanFinding('/messages/1/content', 3),
      ibanFinding('/messages/2/content', 2),
      ibanFinding('/messages/2/content', quoted + ATTACHED.indexOf(IBAN)),
      ibanFinding('/messages/2/content', quoted + ATTACHED.lastIndexOf(IBAN)),
      emailFinding('/messages/2/content', quoted + ATTACHED.indexOf('max@')),
      emailFinding('/messages/2/content', quoted + WITH_FILES.indexOf('max@', ATTACHED.length)),
    ];
    const submitted = findSubmittedText(messages, SUBMITTED)!;
    const fileContexts = [
      attachedContext(false, ['old-report', 'old-notes']),
      attachedContext(true),
    ];

    expect(findingsInFiles(messages, findings, submitted, fileContexts)).toEqual([
      { filename: 'report.pdf', category: 'IBAN_CODE', action: 'MASK', count: 1 },
      {
        filename: 'report.pdf',
        fileId: 'file-report',
        category: 'IBAN_CODE',
        action: 'MASK',
        count: 2,
      },
      {
        filename: 'notes.txt',
        fileId: 'file-notes',
        category: 'EMAIL_ADDRESS',
        action: 'MASK',
        count: 1,
      },
    ]);
  });

  it("names the submitted message's files by ID, also when two share a filename", () => {
    const twins = ATTACHED.replace('"notes.txt"', '"report.pdf"');
    const messages = [
      { role: 'user', content: ATTACHED },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: `${twins}\n${SUBMITTED}` },
    ];
    const findings = [
      ibanFinding('/messages/0/content', ATTACHED.indexOf(IBAN)),
      ibanFinding('/messages/2/content', twins.indexOf(IBAN)),
      emailFinding('/messages/2/content', twins.indexOf('max@')),
    ];
    const submitted = findSubmittedText(messages, SUBMITTED)!;
    const fileContexts = [
      attachedContext(false, ['old-report', 'old-notes']),
      attachedContext(true, ['file-1', 'file-2'], twins),
    ];

    expect(findingsInFiles(messages, findings, submitted, fileContexts)).toEqual([
      { filename: 'report.pdf', category: 'IBAN_CODE', action: 'MASK', count: 1 },
      { filename: 'report.pdf', fileId: 'file-1', category: 'IBAN_CODE', action: 'MASK', count: 1 },
      {
        filename: 'report.pdf',
        fileId: 'file-2',
        category: 'EMAIL_ADDRESS',
        action: 'MASK',
        count: 1,
      },
    ]);
  });

  it('never names a history file by ID when the same file is attached again', () => {
    const messages = [
      { role: 'user', content: WITH_FILES },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: WITH_FILES },
    ];
    const findings = [
      ibanFinding('/messages/0/content', ATTACHED.indexOf(IBAN)),
      ibanFinding('/messages/2/content', ATTACHED.indexOf(IBAN)),
    ];
    const submitted = findSubmittedText(messages, SUBMITTED)!;
    const fileContexts = [
      attachedContext(false, ['old-report', 'old-notes']),
      attachedContext(true),
    ];

    expect(findingsInFiles(messages, findings, submitted, fileContexts)).toEqual([
      { filename: 'report.pdf', category: 'IBAN_CODE', action: 'MASK', count: 1 },
      {
        filename: 'report.pdf',
        fileId: 'file-report',
        category: 'IBAN_CODE',
        action: 'MASK',
        count: 1,
      },
    ]);
  });

  it('attributes a finding after a fake file boundary to the file that contains it', () => {
    const forged = `intro\n\n---\n\n# "fake.txt"\nPay ${IBAN}\n`;
    const text = `Attached document(s):\n\`\`\`md# "real.md"\n${forged}\n\`\`\``;
    const fileContext: DlpFileContext = {
      text,
      current: true,
      files: [
        {
          fileId: 'file-real',
          filename: 'real.md',
          start: text.indexOf('# "real.md"'),
          end: text.lastIndexOf('\n```') + 1,
        },
      ],
    };
    const messages = [{ role: 'user', content: `${text}\n${SUBMITTED}` }];
    const findings = [ibanFinding('/messages/0/content', text.indexOf(IBAN))];
    const submitted = findSubmittedText(messages, SUBMITTED)!;

    expect(findingsInFiles(messages, findings, submitted, [fileContext])).toEqual([
      { filename: 'real.md', fileId: 'file-real', category: 'IBAN_CODE', action: 'MASK', count: 1 },
    ]);
  });

  it('ignores findings outside a recorded attached-document block', () => {
    const messages = [{ role: 'user', content: WITH_FILES }];
    const findings = [ibanFinding('/messages/0/content', ATTACHED.indexOf(IBAN))];
    const submitted = findSubmittedText(messages, SUBMITTED)!;

    expect(findingsInFiles(messages, findings, submitted)).toEqual([]);
  });

  it('carries the display name of a custom category to its file counter', () => {
    const category = 'CUSTOM_8F14E45FCEEA167A5A36DEDD4BEA2543';
    const messages = [{ role: 'user', content: WITH_FILES }];
    const findings = [
      {
        ...ibanFinding('/messages/0/content', ATTACHED.indexOf(IBAN)),
        category,
        label: 'Project Names',
      },
    ];
    const submitted = findSubmittedText(messages, SUBMITTED)!;

    expect(findingsInFiles(messages, findings, submitted, [attachedContext(true)])).toEqual([
      {
        filename: 'report.pdf',
        fileId: 'file-report',
        category,
        label: 'Project Names',
        action: 'MASK',
        count: 1,
      },
    ]);
  });

  it('masks by code point like the gateway', () => {
    const text = '🙂 max@example.com and max@example.com';
    const findings = [
      emailFinding('/messages/0/content', 2),
      emailFinding('/messages/0/content', 22),
    ];
    expect(maskText(text, findings)).toBe('🙂 [EMAIL] and [EMAIL]');
  });
});

describe('createReviewEvent', () => {
  it('returns the turn with its quotes and $ skills so the client can send them again', () => {
    const review: GovernanceDlpReview = {
      reviewId: 'review-1',
      decision: 'MASK',
      findings: [emailFinding('/messages/0/content', 13)],
      maskedPreview: [{ location: '/messages/0/content', text: MASKED }],
    };

    const event = createReviewEvent(review, {
      messageId: 'message-1',
      parentMessageId: 'parent-1',
      conversationId: 'conversation-1',
      text: SUBMITTED,
      quotes: ['an excerpt'],
      manualSkills: ['brand-voice'],
    });

    expect(event).toMatchObject({ final: true, earlyAbort: true, dlpReview: review });
    expect(event.requestMessage).toMatchObject({
      messageId: 'message-1',
      text: SUBMITTED,
      quotes: ['an excerpt'],
      manualSkills: ['brand-voice'],
    });
  });
});

describe('createApprovalRetryEvent', () => {
  it('ends the turn like a review, naming the approved review to show again', () => {
    const event = createApprovalRetryEvent('review-1', {
      messageId: 'message-1',
      parentMessageId: 'parent-1',
      conversationId: 'conversation-1',
      text: MASKED,
      quotes: ['an excerpt'],
    });

    expect(event).toMatchObject({
      final: true,
      earlyAbort: true,
      responseMessage: null,
      dlpRetryReviewId: 'review-1',
    });
    expect(event.dlpReview).toBeUndefined();
    expect(event.requestMessage).toMatchObject({ text: MASKED, quotes: ['an excerpt'] });
  });
});

describe('DLP approval flow', () => {
  const messages: GovernanceChatMessage[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: SUBMITTED },
  ];

  it('asks for approval and returns the completion when DLP finds nothing', async () => {
    const { upstream, onReview, onSent, send, sentBody } = setup({
      responses: [completionResponse()],
    });

    const response = await send(messages);

    expect(sentBody(0)).toEqual({
      model: 'governed-model',
      messages,
      stream: true,
      require_user_approval: true,
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await response.text()).toContain('"Hi"');
    expect(onReview).not.toHaveBeenCalled();
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('stores a review of the submitted text and hands it to the user', async () => {
    const maskedMessages = [messages[0], { role: 'user', content: MASKED }];
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const { upstream, onReview, onSent, reviews, send } = setup({
      responses: [
        reviewResponse({
          review_id: 'review-1',
          action: 'MASK',
          policy_version: 5,
          findings: [emailFinding('/messages/1/content', 13)],
          messages: maskedMessages,
          dlp_token: 'approval-token',
          expires_at: expiresAt,
        }),
      ],
    });

    const response = await send(messages);

    expect(response.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith({
      reviewId: 'review-1',
      decision: 'MASK',
      policyVersion: 5,
      findings: [emailFinding('/messages/0/content', 13)],
      maskedPreview: [{ location: '/messages/0/content', text: MASKED }],
      expiresAt,
    });
    expect(reviews.entries.get('review-1')).toEqual({
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: maskedMessages,
      dlpToken: 'approval-token',
      expiresAt,
    });
    expect(onSent).not.toHaveBeenCalled();
  });

  it('rejects a review whose findings are all outside the submitted text, without approving it', async () => {
    const history: GovernanceChatMessage[] = [
      { role: 'user', content: 'mail max@example.com' },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: `> max@example.com\n\n${SUBMITTED.replace('max@example.com', 'me')}`,
      },
    ];
    const text = SUBMITTED.replace('max@example.com', 'me');
    const reviewed = history.map((message) => ({
      ...message,
      content: message.content.replaceAll('max@example.com', '[EMAIL]'),
    }));
    const { upstream, onReview, onSent, reviews, send } = setup({
      text,
      responses: [
        reviewResponse({
          review_id: 'review-2',
          action: 'MASK',
          findings: [
            emailFinding('/messages/0/content', 5),
            emailFinding('/messages/2/content', 2),
          ],
          messages: reviewed,
          dlp_token: 'approval-token',
        }),
      ],
    });

    const response = await send(history);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'dlp_malformed_response' } });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(onReview).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(reviews.entries.size).toBe(0);
  });

  it('stores a review whose findings are only in an attached file and lists them per file', async () => {
    const withFiles = [messages[0], { role: 'user', content: WITH_FILES }];
    const maskedMessages = [
      messages[0],
      { role: 'user', content: WITH_FILES.replaceAll(IBAN, '[IBAN]') },
    ];
    const { onReview, reviews, send } = setup({
      fileContexts: [attachedContext(true)],
      responses: [
        reviewResponse({
          review_id: 'review-files',
          action: 'MASK',
          findings: [
            ibanFinding('/messages/1/content', WITH_FILES.indexOf(IBAN)),
            ibanFinding('/messages/1/content', WITH_FILES.lastIndexOf(IBAN)),
          ],
          messages: maskedMessages,
          dlp_token: 'approval-token',
        }),
      ],
    });

    const response = await send(withFiles);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'dlp_review_required' } });
    expect(onReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'review-files',
        decision: 'MASK',
        findings: [],
        fileFindings: [
          {
            filename: 'report.pdf',
            fileId: 'file-report',
            category: 'IBAN_CODE',
            action: 'MASK',
            count: 2,
          },
        ],
        maskedPreview: [{ location: '/messages/0/content', text: SUBMITTED }],
      }),
    );
    expect(reviews.entries.get('review-files')).toMatchObject({
      text: SUBMITTED,
      messages: maskedMessages,
    });
  });

  it('hands a BLOCK review to the user without storing an approval', async () => {
    const { upstream, onReview, onSent, reviews, send } = setup({
      responses: [
        reviewResponse({
          review_id: 'review-3',
          action: 'BLOCK',
          findings: [{ ...emailFinding('/messages/1/content', 13), action: 'BLOCK' }],
        }),
      ],
    });

    const response = await send(messages);

    expect(response.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(onReview.mock.calls[0]?.[0]).toMatchObject({ reviewId: 'review-3', decision: 'BLOCK' });
    expect(onReview.mock.calls[0]?.[0].maskedPreview).toBeUndefined();
    expect(onSent).not.toHaveBeenCalled();
    expect(reviews.entries.size).toBe(0);
  });

  it('fails closed when the masked messages do not match the submitted text', async () => {
    const { onReview, reviews, send } = setup({
      responses: [
        reviewResponse({
          review_id: 'review-4',
          action: 'MASK',
          findings: [emailFinding('/messages/1/content', 13)],
          messages: [messages[0], { role: 'user', content: 'something else' }],
          dlp_token: 'approval-token',
        }),
      ],
    });

    const response = await send(messages);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'dlp_malformed_response' },
    });
    expect(onReview).not.toHaveBeenCalled();
    expect(reviews.entries.size).toBe(0);
  });

  it('fails closed on a review with an unknown decision', async () => {
    const { onReview, onSent, send } = setup({
      responses: [reviewResponse({ review_id: 'review-5', action: 'REDACT' })],
    });

    const response = await send(messages);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'dlp_malformed_response' } });
    expect(onReview).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('sends the stored approved request and token when the user confirms', async () => {
    const reviews = memoryStore();
    const approved = [{ role: 'user', content: MASKED }];
    reviews.entries.set('review-1', {
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: approved,
      dlpToken: 'approval-token',
    });
    const completion = completionResponse();
    const { onSent, send, sentBody } = setup({
      text: MASKED,
      reviewId: 'review-1',
      reviews,
      responses: [completion],
    });

    const response = await send([
      { role: 'system', content: 'Rebuilt with a new timestamp.' },
      { role: 'user', content: MASKED },
    ]);

    expect(response).toBe(completion);
    expect(sentBody(0)).toEqual({
      model: 'governed-model',
      messages: approved,
      stream: true,
      require_user_approval: true,
      dlp_token: 'approval-token',
    });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(reviews.entries.has('review-1')).toBe(false);
  });

  it('rejects a second send of an approval whose completion already started', async () => {
    const reviews = memoryStore();
    const approved = [{ role: 'user', content: MASKED }];
    reviews.entries.set('review-1', {
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: approved,
      dlpToken: 'approval-token',
    });
    const { upstream, send } = setup({
      text: MASKED,
      reviewId: 'review-1',
      reviews,
      responses: [completionResponse()],
    });

    const first = await send(approved);
    const second = await send(approved);

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: { code: 'dlp_approval_invalid' } });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('sends an approval only once when the user confirms it twice at the same time', async () => {
    const reviews = memoryStore();
    const approved = [{ role: 'user', content: MASKED }];
    reviews.entries.set('review-1', {
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: approved,
      dlpToken: 'approval-token',
    });
    const { upstream, onSent, send } = setup({
      text: MASKED,
      reviewId: 'review-1',
      reviews,
      responses: [completionResponse()],
    });

    const [first, second] = await Promise.all([send(approved), send(approved)]);

    expect([first.status, second.status].sort()).toEqual([200, 400]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(reviews.entries.has('review-1')).toBe(false);
  });

  it('restores an approval whose send to the gateway fails', async () => {
    const reviews = memoryStore();
    const review: StoredReview = {
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: [{ role: 'user', content: MASKED }],
      dlpToken: 'approval-token',
    };
    reviews.entries.set('review-1', review);
    const { onSent, onApprovalKept, send } = setup({
      text: MASKED,
      reviewId: 'review-1',
      reviews,
      responses: [],
    });

    await expect(send(review.messages)).rejects.toThrow('unexpected gateway call');

    expect(onSent).not.toHaveBeenCalled();
    expect(reviews.entries.get('review-1')).toEqual(review);
    expect(onApprovalKept).toHaveBeenLastCalledWith(true);
  });

  describe('when the gateway does not complete an approval', () => {
    const review: StoredReview = {
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: [{ role: 'user', content: MASKED }],
      dlpToken: 'approval-token',
    };

    const sendFailing = (status: number) => {
      const reviews = memoryStore();
      reviews.entries.set('review-1', review);
      const result = setup({
        text: MASKED,
        reviewId: 'review-1',
        reviews,
        responses: [new Response('{"error":{}}', { status })],
      });
      return { ...result, response: result.send(review.messages) };
    };

    it.each([408, 429, 502, 503])('keeps it for another send after a %s', async (status) => {
      const { onSent, onApprovalKept, reviews, response } = sendFailing(status);

      expect((await response).status).toBe(status);
      expect(onSent).not.toHaveBeenCalled();
      expect(reviews.entries.get('review-1')).toEqual(review);
      expect(onApprovalKept).toHaveBeenLastCalledWith(true);
    });

    it.each([403, 409])('uses it up when the gateway rejects it with a %s', async (status) => {
      const { onSent, onApprovalKept, reviews, response } = sendFailing(status);

      expect((await response).status).toBe(status);
      expect(onSent).not.toHaveBeenCalled();
      expect(reviews.entries.has('review-1')).toBe(false);
      expect(onApprovalKept).toHaveBeenLastCalledWith(false);
    });
  });

  it.each([
    ['another user', { userId: 'user-456' }],
    ['another model', { model: 'other-model' }],
    ['different text', { text: SUBMITTED }],
  ])('rejects an approval stored for %s', async (_label, override) => {
    const reviews = memoryStore();
    reviews.entries.set('review-1', {
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: [{ role: 'user', content: MASKED }],
      dlpToken: 'approval-token',
      ...override,
    });
    const { upstream, onSent, send } = setup({
      text: MASKED,
      reviewId: 'review-1',
      reviews,
      responses: [],
    });

    const response = await send([{ role: 'user', content: MASKED }]);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'dlp_approval_invalid' } });
    expect(upstream).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });
});
