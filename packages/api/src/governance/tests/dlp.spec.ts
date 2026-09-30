import { ContentTypes } from 'librechat-data-provider';
import type { TConversation, TEditedContent, TEphemeralAgent } from 'librechat-data-provider';
import type { GovernanceFetch, GovernanceSubmissionBody } from '../dlp';
import type { ServerRequest } from '~/types/http';
import {
  onDlpSent,
  isDlpUnsent,
  hasSelectedTools,
  isPlainTextSubmission,
  createRequestDlpFetch,
  isGovernanceGatewayUrl,
  createGovernanceDlpFetch,
} from '../dlp';

const environmentKeys = ['GOVERNANCE_API_BASE_URL', 'LIBRECHAT_SERVICE_CREDENTIAL'] as const;

const originalEnvironment = new Map<string, string | undefined>(
  environmentKeys.map((key): [string, string | undefined] => [key, process.env[key]]),
);

beforeEach(() => {
  process.env.GOVERNANCE_API_BASE_URL = 'http://governance.test/api/v1/dlp';
  process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'server-only-credential';
});

afterAll(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('Governance DLP', () => {
  it.each([
    ['http://governance.test/api/v1/dlp', 'http://governance.test/api/v1/dlp/', true],
    ['http://governance.test/api/v1/dlp', 'http://other.test/api/v1/dlp', false],
    ['http://governance.test/v1', 'http://governance.test/api/v1/dlp', false],
  ])('matches completion base URL %s against configured %s', (baseURL, configured, expected) => {
    process.env.GOVERNANCE_API_BASE_URL = configured;
    expect(isGovernanceGatewayUrl(baseURL)).toBe(expected);
  });

  it('forwards the text-only request to the DLP completions API without consuming the stream', async () => {
    const upstreamResponse = new Response('stream remains intact');
    const upstreamFetch = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => upstreamResponse,
    );
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
    });

    const result = await governedFetch('http://governance.test/api/v1/dlp/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'governed-model',
        messages: [{ role: 'user', content: 'sensitive text' }],
        stream: true,
        temperature: 0.4,
        user: 'user-123',
        stream_options: { include_usage: true },
        top_p: 0.8,
      }),
    });

    const headers = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(headers.get('X-LibreChat-User-ID')).toBe('user-123');
    expect(upstreamFetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        model: 'governed-model',
        messages: [{ role: 'user', content: 'sensitive text' }],
        stream: true,
        temperature: 0.4,
      }),
    );
    expect(result).toBe(upstreamResponse);
  });

  it('rejects an unsupported request to the DLP completions API instead of forwarding it', async () => {
    const upstreamFetch = jest.fn();
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
    });

    await expect(
      governedFetch('http://governance.test/api/v1/dlp/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'governed-model',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'normal text' }] }],
        }),
      }),
    ).rejects.toMatchObject({ code: 'dlp_check_unsupported_request' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects a Responses API completion instead of forwarding it without a scan', async () => {
    const upstreamFetch = jest.fn();
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
    });

    await expect(
      governedFetch('http://governance.test/api/v1/dlp/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'governed-model',
          input: [{ role: 'user', content: 'normal text' }],
        }),
      }),
    ).rejects.toMatchObject({ code: 'dlp_check_unsupported_request' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('passes a non-completion request through untouched', async () => {
    const url = 'http://governance.test/api/v1/dlp/models';
    const init: RequestInit = { method: 'GET' };
    const upstreamResponse = new Response('[]');
    const upstreamFetch = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => upstreamResponse,
    );
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
    });

    const result = await governedFetch(url, init);

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledWith(url, init);
    expect(result).toBe(upstreamResponse);
  });
});

describe('governed turn sent state', () => {
  const governedRequest = (): ServerRequest =>
    ({
      body: { text: 'normal text' },
      user: { id: 'user-123' } as ServerRequest['user'],
    }) as ServerRequest;

  const completion = (): Response =>
    new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });

  const send = (governedFetch: GovernanceFetch) =>
    governedFetch('http://governance.test/api/v1/dlp/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'governed-model',
        messages: [{ role: 'user', content: 'normal text' }],
        stream: true,
      }),
    });

  it('runs a callback at once for a turn that is not governed', () => {
    const req = governedRequest();
    const callback = jest.fn();

    onDlpSent(req, callback);
    onDlpSent(undefined, callback);

    expect(isDlpUnsent(req)).toBe(false);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('holds a callback until the gateway starts the completion, and runs it once', async () => {
    const req = governedRequest();
    const governedFetch = createRequestDlpFetch(req, async () => completion());
    const callback = jest.fn();

    onDlpSent(req, callback);
    expect(isDlpUnsent(req)).toBe(true);
    expect(callback).not.toHaveBeenCalled();

    await send(governedFetch);
    await send(governedFetch);

    expect(isDlpUnsent(req)).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('leaves the turn unsent when the gateway does not start a completion', async () => {
    const req = governedRequest();
    const governedFetch = createRequestDlpFetch(
      req,
      async () =>
        new Response('{"error":{"code":"governance_processing_failed"}}', { status: 503 }),
    );
    const callback = jest.fn();
    onDlpSent(req, callback);

    const response = await send(governedFetch);

    expect(response.status).toBe(503);
    expect(isDlpUnsent(req)).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps a sent turn sent when its fetch is created again', async () => {
    const req = governedRequest();
    await send(createRequestDlpFetch(req, async () => completion()));

    createRequestDlpFetch(req, async () => completion());

    expect(isDlpUnsent(req)).toBe(false);
  });
});

const plainTextBody = (overrides: GovernanceSubmissionBody = {}): GovernanceSubmissionBody => ({
  text: 'a normal question',
  ...overrides,
});

describe('hasSelectedTools', () => {
  it('is false for a missing or empty ephemeral agent', () => {
    expect(hasSelectedTools()).toBe(false);
    expect(hasSelectedTools(null)).toBe(false);
    expect(hasSelectedTools({ mcp: [] })).toBe(false);
  });

  it.each<[string, TEphemeralAgent]>([
    ['mcp servers', { mcp: ['server-a'] }],
    ['web search', { web_search: true }],
    ['file search', { file_search: true }],
    ['code execution', { execute_code: true }],
  ])('is true when %s is selected', (_label, agent) => {
    expect(hasSelectedTools(agent)).toBe(true);
  });
});

describe('isPlainTextSubmission', () => {
  it('accepts a first-turn plain-text message', () => {
    expect(isPlainTextSubmission(plainTextBody())).toBe(true);
  });

  it.each([
    'AI Governance Gateway__gemini-3.6-flash',
    'AI Governance Gateway__gemini-3.6-flash___Assistant',
    'AI Governance Gateway__gemini-3.6-flash___Assistant____1',
  ])('checks plain-text follow-ups with ephemeral agent ID %s', (agent_id) => {
    expect(isPlainTextSubmission(plainTextBody({ agent_id }))).toBe(true);
    expect(
      isPlainTextSubmission(plainTextBody({ agent_id, ephemeralAgent: { web_search: true } })),
    ).toBe(false);
    expect(isPlainTextSubmission(plainTextBody({ agent_id, files: [{ file_id: 'f1' }] }))).toBe(
      false,
    );
  });

  const editedContent: TEditedContent = {
    index: 0,
    type: ContentTypes.TEXT,
    [ContentTypes.TEXT]: 'edited',
  };

  it.each<[string, GovernanceSubmissionBody]>([
    ['blank text', { text: '   ' }],
    ['missing text', { text: undefined }],
    ['an edit', { editedContent }],
    ['a continuation', { isContinued: true }],
    ['a regeneration', { isRegenerate: true }],
    ['an added conversation', { addedConvo: { conversationId: 'c1' } as TConversation }],
    ['a saved agent target', { agent_id: 'agent_1' }],
    ['a saved agent with a conversation index', { agent_id: 'agent_1____1' }],
    ['an assistant target', { assistant_id: 'asst-1' }],
    ['attached files', { files: [{ file_id: 'f1' }] }],
    ['selected tools list', { tools: ['web-browser'] }],
    ['an ephemeral tool', { ephemeralAgent: { web_search: true } }],
  ])('rejects a submission with %s', (_label, overrides) => {
    expect(isPlainTextSubmission(plainTextBody(overrides))).toBe(false);
  });

  it('ignores empty file and tool arrays', () => {
    expect(isPlainTextSubmission(plainTextBody({ files: [], tools: [] }))).toBe(true);
  });
});
