import { ErrorTypes, ContentTypes } from 'librechat-data-provider';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { TConversation, TEditedContent, TEphemeralAgent } from 'librechat-data-provider';
import {
  getModel,
  checkDlp,
  hasSelectedTools,
  createDlpIntervention,
  isPlainTextSubmission,
  createGovernanceDlpFetch,
  GovernanceDlpError,
  type CheckDlpParams,
  type DlpCheckResponse,
  type DlpCheckResult,
  type HttpPoster,
  type GovernanceSubmissionBody,
} from '../dlp';

const environmentKeys = ['GOVERNANCE_API_BASE_URL', 'LIBRECHAT_SERVICE_CREDENTIAL'] as const;

const originalEnvironment = new Map<string, string | undefined>(
  environmentKeys.map((key): [string, string | undefined] => [key, process.env[key]]),
);

beforeEach(() => {
  process.env.GOVERNANCE_API_BASE_URL = 'http://governance.test/v1';
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
  it('checks a text request on the server with the service credential', async () => {
    const calls: Array<{
      url: string;
      body: CheckDlpParams['request'];
      config: AxiosRequestConfig;
    }> = [];
    const http: HttpPoster = async (url, body, config) => {
      calls.push({ url, body, config });
      return {
        status: 200,
        data: {
          action: 'ALLOW',
          policy_version: 7,
          findings: [],
          dlp_token: 'signed-dlp-token',
        },
      } as AxiosResponse<DlpCheckResponse>;
    };

    const result = await checkDlp({
      request: {
        model: 'governed-model',
        messages: [{ role: 'user', content: 'normal text' }],
      },
      userId: 'user-123',
      http,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'http://governance.test/api/v1/dlp/check',
      body: {
        model: 'governed-model',
        messages: [{ role: 'user', content: 'normal text' }],
      },
      config: {
        timeout: 10000,
        headers: {
          Authorization: 'Bearer server-only-credential',
          'X-LibreChat-User-ID': 'user-123',
        },
      },
    });
    expect(result).toEqual({
      decision: 'ALLOW',
      policyVersion: 7,
      findings: [],
      dlpToken: 'signed-dlp-token',
    });
  });

  it('creates the existing intervention payload for every non-allow decision', () => {
    for (const [decision, status, type] of [
      ['WARN', 422, ErrorTypes.GOVERNANCE_INTERVENTION],
      ['MASK', 422, ErrorTypes.GOVERNANCE_INTERVENTION],
      ['BLOCK', 403, ErrorTypes.GOVERNANCE_BLOCKED],
    ] as const) {
      const intervention = createDlpIntervention({
        decision,
        findings: [],
        dlpToken: 'signed-dlp-token',
      });

      expect(intervention).toMatchObject({
        status,
        body: {
          type,
          decision,
          dlp_token: 'signed-dlp-token',
        },
      });
    }
  });

  it('forwards the exact check token and text-only request without consuming the stream', async () => {
    const upstreamResponse = new Response('stream remains intact');
    const upstreamFetch = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => upstreamResponse,
    );
    const check = jest.fn(
      async (_params: CheckDlpParams): Promise<DlpCheckResult> => ({
        decision: 'ALLOW',
        findings: [],
        dlpToken: 'signed-dlp-token',
      }),
    );
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
      check,
    });

    const result = await governedFetch('http://governance.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'governed-model',
        messages: [{ role: 'user', content: 'normal text' }],
        stream: true,
        temperature: 0.4,
        user: 'user-123',
        stream_options: { include_usage: true },
        top_p: 0.8,
      }),
    });

    expect(check).toHaveBeenCalledWith({
      userId: 'user-123',
      request: {
        model: 'governed-model',
        messages: [{ role: 'user', content: 'normal text' }],
        stream: true,
        temperature: 0.4,
      },
    });
    expect(new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers).get('X-DLP-Token')).toBe(
      'signed-dlp-token',
    );
    expect(new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers).get('X-LibreChat-User-ID')).toBe(
      'user-123',
    );
    expect(upstreamFetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        model: 'governed-model',
        messages: [{ role: 'user', content: 'normal text' }],
        stream: true,
        temperature: 0.4,
      }),
    );
    expect(result).toBe(upstreamResponse);
  });

  it.each(['WARN', 'MASK'] as const)(
    'forwards a %s decision to the completion call with its DLP token instead of blocking',
    async (decision) => {
      const upstreamResponse = new Response('stream remains intact');
      const upstreamFetch = jest.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
          upstreamResponse,
      );
      const check = jest.fn(
        async (_params: CheckDlpParams): Promise<DlpCheckResult> => ({
          decision,
          findings: [],
          dlpToken: 'signed-dlp-token',
        }),
      );
      const governedFetch = createGovernanceDlpFetch({
        userId: 'user-123',
        fetch: upstreamFetch,
        check,
      });

      const result = await governedFetch('http://governance.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'governed-model',
          messages: [{ role: 'user', content: 'sensitive text' }],
        }),
      });

      expect(upstreamFetch).toHaveBeenCalledTimes(1);
      expect(new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers).get('X-DLP-Token')).toBe(
        'signed-dlp-token',
      );
      expect(result).toBe(upstreamResponse);
    },
  );

  it('throws instead of calling the completion endpoint on a BLOCK decision', async () => {
    const upstreamFetch = jest.fn();
    const check = jest.fn(
      async (_params: CheckDlpParams): Promise<DlpCheckResult> => ({
        decision: 'BLOCK',
        findings: [],
      }),
    );
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
      check,
    });

    await expect(
      governedFetch('http://governance.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'governed-model',
          messages: [{ role: 'user', content: 'blocked text' }],
        }),
      }),
    ).rejects.toBeInstanceOf(GovernanceDlpError);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects a Responses API completion instead of forwarding it without a scan or token', async () => {
    const upstreamFetch = jest.fn();
    const check = jest.fn();
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
      check,
    });

    await expect(
      governedFetch('http://governance.test/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'governed-model',
          input: [{ role: 'user', content: 'normal text' }],
        }),
      }),
    ).rejects.toMatchObject({ code: 'dlp_check_unsupported_request' });
    expect(check).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('still passes non-completion requests through untouched', async () => {
    const upstreamResponse = new Response('[]');
    const upstreamFetch = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => upstreamResponse,
    );
    const check = jest.fn();
    const governedFetch = createGovernanceDlpFetch({
      userId: 'user-123',
      fetch: upstreamFetch,
      check,
    });

    const result = await governedFetch('http://governance.test/v1/models', { method: 'GET' });

    expect(check).not.toHaveBeenCalled();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(upstreamResponse);
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
    ['an agent target', { agent_id: 'agent-1' }],
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

describe('getModel', () => {
  it('prefers the resolved endpoint model parameters', () => {
    const body = plainTextBody({
      model: 'raw-model',
      endpointOption: {
        model_parameters: { model: 'param-model' },
        modelOptions: { model: 'option-model' },
      },
    });
    expect(getModel(body)).toBe('param-model');
  });

  it('falls back to modelOptions, then the raw body model', () => {
    expect(
      getModel(
        plainTextBody({
          model: 'raw-model',
          endpointOption: { modelOptions: { model: 'option-model' } },
        }),
      ),
    ).toBe('option-model');
    expect(getModel(plainTextBody({ model: 'raw-model' }))).toBe('raw-model');
  });

  it('returns "unknown" when no model is present', () => {
    expect(getModel(plainTextBody())).toBe('unknown');
  });
});
