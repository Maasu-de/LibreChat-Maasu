import type { GovernanceDlpReview, GovernanceFinding } from 'librechat-data-provider';
import type { GatewayReview, ReviewMessage, ReviewStore, StoredReview } from '../review';
import { maskText, readReview, findSubmittedText, findingsInSubmittedText } from '../review';
import { createGovernanceDlpFetch } from '../dlp';

const DLP_COMPLETIONS_URL = 'http://governance.test/api/v1/dlp/chat/completions';
const SUBMITTED = 'Please email max@example.com today';
const MASKED = 'Please email [EMAIL] today';

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
  reviews = memoryStore(),
}: {
  responses: Response[];
  text?: string;
  reviewId?: string;
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
  const governedFetch = createGovernanceDlpFetch({
    userId: 'user-123',
    fetch: upstream,
    text,
    reviewId,
    onReview,
    onSent,
    reviews,
  });
  const send = (messages: ReviewMessage[]) =>
    governedFetch(DLP_COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'governed-model', messages, stream: true, top_p: 0.5 }),
    });
  const sentBody = (call: number) => JSON.parse(String(upstream.mock.calls[call]?.[1]?.body));
  return { upstream, onReview, onSent, reviews, send, sentBody };
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

  it('masks by code point like the gateway', () => {
    const text = '🙂 max@example.com and max@example.com';
    const findings = [
      emailFinding('/messages/0/content', 2),
      emailFinding('/messages/0/content', 22),
    ];
    expect(maskText(text, findings)).toBe('🙂 [EMAIL] and [EMAIL]');
  });
});

describe('DLP approval flow', () => {
  const messages: ReviewMessage[] = [
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
    const { upstream, onReview, onSent, reviews, send } = setup({
      responses: [
        reviewResponse({
          review_id: 'review-1',
          action: 'MASK',
          policy_version: 5,
          findings: [emailFinding('/messages/1/content', 13)],
          messages: maskedMessages,
          dlp_token: 'approval-token',
          expires_at: Math.floor(Date.now() / 1000) + 600,
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
      expiresAt: expect.any(Number),
    });
    expect(reviews.entries.get('review-1')).toEqual({
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: maskedMessages,
      dlpToken: 'approval-token',
    });
    expect(onSent).not.toHaveBeenCalled();
  });

  it('completes a review at once when every finding is in an earlier message', async () => {
    const history: ReviewMessage[] = [
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
    const completion = completionResponse();
    const { onReview, onSent, reviews, send, sentBody } = setup({
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
        completion,
      ],
    });

    const response = await send(history);

    expect(response).toBe(completion);
    expect(sentBody(1)).toEqual({
      model: 'governed-model',
      messages: reviewed,
      stream: true,
      require_user_approval: true,
      dlp_token: 'approval-token',
    });
    expect(onReview).not.toHaveBeenCalled();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(reviews.entries.size).toBe(0);
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
      error: { code: 'dlp_check_malformed_response' },
    });
    expect(onReview).not.toHaveBeenCalled();
    expect(reviews.entries.size).toBe(0);
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

  it('keeps an approval the gateway does not complete, and does not count it as sent', async () => {
    const reviews = memoryStore();
    reviews.entries.set('review-1', {
      userId: 'user-123',
      model: 'governed-model',
      text: MASKED,
      messages: [{ role: 'user', content: MASKED }],
      dlpToken: 'approval-token',
    });
    const { onSent, send } = setup({
      text: MASKED,
      reviewId: 'review-1',
      reviews,
      responses: [new Response('{"error":{"code":"dlp_review_required"}}', { status: 409 })],
    });

    const response = await send([{ role: 'user', content: MASKED }]);

    expect(response.status).toBe(409);
    expect(onSent).not.toHaveBeenCalled();
    expect(reviews.entries.has('review-1')).toBe(true);
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
