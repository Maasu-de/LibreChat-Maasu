import { AuthType } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';

const mockValidateEndpointURL = jest.fn();
jest.mock('~/auth', () => ({
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
}));

const mockGetOpenAIConfig = jest.fn().mockReturnValue({
  llmConfig: { model: 'test-model' },
  configOptions: {},
});
jest.mock('~/endpoints/openai/config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/endpoints/models', () => ({
  fetchModels: jest.fn(),
}));

jest.mock('~/cache', () => ({
  standardCache: jest.fn(() => ({ get: jest.fn().mockResolvedValue(null) })),
}));

jest.mock('~/utils', () => ({
  isUserProvided: (val: string) => val === 'user_provided',
  checkUserKeyExpiry: jest.fn(),
}));

const mockGetCustomEndpointConfig = jest.fn();
jest.mock('~/app/config', () => ({
  getCustomEndpointConfig: (...args: unknown[]) => mockGetCustomEndpointConfig(...args),
}));

import { initializeCustom } from './initialize';

function createParams(overrides: {
  apiKey?: string;
  baseURL?: string;
  userBaseURL?: string;
  userApiKey?: string;
  expiresAt?: string;
}): BaseInitializeParams {
  const { apiKey = 'sk-test-key', baseURL = 'https://api.example.com/v1' } = overrides;

  mockGetCustomEndpointConfig.mockReturnValue({
    apiKey,
    baseURL,
    models: {},
  });

  const db = {
    getUserKeyValues: jest.fn().mockResolvedValue({
      apiKey: overrides.userApiKey ?? 'sk-user-key',
      baseURL: overrides.userBaseURL ?? 'https://user-api.example.com/v1',
    }),
  } as unknown as BaseInitializeParams['db'];

  return {
    req: {
      user: { id: 'user-1' },
      body: { key: overrides.expiresAt ?? '2099-01-01' },
      config: {},
    } as unknown as BaseInitializeParams['req'],
    endpoint: 'test-custom',
    model_parameters: { model: 'gpt-4' },
    db,
  };
}

describe('initializeCustom – SSRF guard wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call validateEndpointURL when baseURL is user_provided', async () => {
    const params = createParams({
      apiKey: 'sk-test-key',
      baseURL: AuthType.USER_PROVIDED,
      userBaseURL: 'https://user-api.example.com/v1',
      expiresAt: '2099-01-01',
    });

    await initializeCustom(params);

    expect(mockValidateEndpointURL).toHaveBeenCalledTimes(1);
    expect(mockValidateEndpointURL).toHaveBeenCalledWith(
      'https://user-api.example.com/v1',
      'test-custom',
    );
  });

  it('should NOT call validateEndpointURL when baseURL is system-defined', async () => {
    const params = createParams({
      apiKey: 'sk-test-key',
      baseURL: 'https://api.provider.com/v1',
    });

    await initializeCustom(params);

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should propagate SSRF rejection from validateEndpointURL', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(
      new Error('Base URL for test-custom targets a restricted address.'),
    );

    const params = createParams({
      apiKey: 'sk-test-key',
      baseURL: AuthType.USER_PROVIDED,
      userBaseURL: 'http://169.254.169.254/latest/meta-data/',
      expiresAt: '2099-01-01',
    });

    await expect(initializeCustom(params)).rejects.toThrow('targets a restricted address');
    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });
});

describe('initializeCustom – governed pilot destination', () => {
  const keys = [
    'GOVERNANCE_PILOT_ENABLED',
    'GOVERNANCE_DLP_ENABLED',
    'GOVERNANCE_API_BASE_URL',
    'LIBRECHAT_SERVICE_CREDENTIAL',
  ] as const;
  const previousEnvironment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOVERNANCE_PILOT_ENABLED = 'true';
    process.env.GOVERNANCE_DLP_ENABLED = 'true';
    process.env.GOVERNANCE_API_BASE_URL = 'https://gateway.example/v1';
    process.env.LIBRECHAT_SERVICE_CREDENTIAL = 'pilot-service-key';
  });

  afterAll(() => {
    for (const key of keys) {
      const value = previousEnvironment[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('installs final-message DLP even without the preflight eligibility flag', async () => {
    const params = createParams({
      apiKey: 'pilot-service-key',
      baseURL: 'https://gateway.example/v1',
    });
    params.endpoint = 'AI Governance Gateway';
    const result = await initializeCustom(params);
    expect(result.configOptions?.fetch).toEqual(expect.any(Function));
    expect(params.db.getUserKeyValues).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: 'pilot-service-key', baseURL: 'https://provider.example/v1' },
    { apiKey: 'user_provided', baseURL: 'https://gateway.example/v1' },
    { apiKey: 'pilot-service-key', baseURL: 'user_provided' },
  ])('rejects stale or administratively changed credentials/URLs: %j', async (override) => {
    const params = createParams(override);
    params.endpoint = 'AI Governance Gateway';
    await expect(initializeCustom(params)).rejects.toThrow('only permits');
    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
    expect(params.db.getUserKeyValues).not.toHaveBeenCalled();
  });

  it('rejects another named endpoint even if it points at the gateway', async () => {
    const params = createParams({
      apiKey: 'pilot-service-key',
      baseURL: 'https://gateway.example/v1',
    });
    await expect(initializeCustom(params)).rejects.toThrow('only permits');
    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });
});
