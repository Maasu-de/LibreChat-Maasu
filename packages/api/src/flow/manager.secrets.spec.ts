import { Keyv } from 'keyv';
import type { MCPOAuthTokens } from '~/mcp/oauth/types';
import type { FlowMetadata } from './types';

let FlowManager: typeof import('./manager').FlowStateManager;
const environment = process.env;
const flowId = 'administrator:managed-connection';
const metadata: FlowMetadata = {
  clientInfo: { client_id: 'client', client_secret: 'private-client-secret' },
  codeVerifier: 'private-code-verifier',
  oauthHeaders: { Authorization: 'Bearer private-service-credential' },
};
const tokens: MCPOAuthTokens = {
  access_token: 'private-access-token',
  refresh_token: 'private-refresh-token',
  token_type: 'Bearer',
  obtained_at: Date.now(),
  expires_at: Date.now() + 3600000,
};
const secrets = [
  'private-client-secret',
  'private-code-verifier',
  'private-service-credential',
  tokens.access_token,
  tokens.refresh_token!,
];

beforeAll(async () => {
  process.env = {
    ...environment,
    CREDS_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    CREDS_IV: '0123456789abcdef0123456789abcdef',
  };
  FlowManager = (await import('./manager')).FlowStateManager;
});

beforeEach(() => {
  process.env.GOVERNANCE_PILOT_ENABLED = 'true';
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = environment;
});

function fixture(ttl = 60000) {
  const backing = new Map<string, string>();
  const cache = new Keyv({ store: backing });
  const manager = new FlowManager<MCPOAuthTokens | null>(cache, { ttl, ci: true });
  const serialized = () => JSON.stringify([...backing.values()]);
  const expectEncrypted = () => {
    for (const secret of secrets) expect(serialized()).not.toContain(secret);
    expect(serialized()).toContain('encrypted');
  };
  return { cache, manager, serialized, expectEncrypted };
}

it.each(['mcp_oauth', 'mcp_get_tokens'])(
  'encrypts %s metadata and tokens while preserving cross-instance completion',
  async (type) => {
    const { cache, manager, expectEncrypted } = fixture();
    await manager.initFlow(flowId, type, metadata);
    expectEncrypted();
    const callback = new FlowManager<MCPOAuthTokens | null>(cache, { ttl: 60000, ci: true });
    expect(await callback.getFlowState(flowId, type)).toMatchObject({
      status: 'PENDING',
      metadata,
    });
    const waiting = manager.createFlow(flowId, type);
    expect(await callback.completeFlow(flowId, type, tokens)).toBe(true);
    await expect(waiting).resolves.toEqual(tokens);
    expectEncrypted();
    expect(await manager.getFlowState(flowId, type)).toMatchObject({
      status: 'COMPLETED',
      result: tokens,
    });
    expect(await callback.completeFlow(flowId, type, null)).toBe(true);
    expect((await manager.getFlowState(flowId, type))?.result).toEqual(tokens);
  },
);

it('keeps failed OAuth flow metadata and provider errors encrypted', async () => {
  const { manager, expectEncrypted } = fixture();
  await manager.initFlow(flowId, 'mcp_oauth', metadata);
  expect(await manager.failFlow(flowId, 'mcp_oauth', new Error(secrets[0]))).toBe(true);
  expectEncrypted();
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({
    status: 'FAILED',
    metadata,
    error: secrets[0],
  });
  expect(await manager.isFlowStale(flowId, 'mcp_oauth')).toMatchObject({ status: 'FAILED' });
});

it('decrypts token-handler results and refreshes expired cached tokens', async () => {
  const { manager, expectEncrypted } = fixture();
  await manager.initFlow(flowId, 'mcp_get_tokens', metadata);
  await manager.completeFlow(flowId, 'mcp_get_tokens', { ...tokens, expires_at: Date.now() - 1 });
  const refreshed = { ...tokens, access_token: 'refreshed-private-access-token' };
  const refresh = jest.fn(async () => refreshed);
  await expect(manager.createFlowWithHandler(flowId, 'mcp_get_tokens', refresh)).resolves.toEqual(
    refreshed,
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  expectEncrypted();
  await expect(manager.createFlowWithHandler(flowId, 'mcp_get_tokens', refresh)).resolves.toEqual(
    refreshed,
  );
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('preserves the cache lifetime and deletion semantics', async () => {
  const ttl = 60000;
  const { cache, manager } = fixture(ttl);
  const before = Date.now();
  await manager.initFlow(flowId, 'mcp_oauth', metadata);
  const stored = await cache.get(`mcp_oauth:${flowId}`, { raw: true });
  expect(stored?.expires).toBeGreaterThanOrEqual(before + ttl);
  expect(stored?.expires).toBeLessThanOrEqual(Date.now() + ttl);
  jest.spyOn(Date, 'now').mockReturnValue(stored!.expires! + 1);
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toBeUndefined();
  jest.restoreAllMocks();
  await manager.initFlow(flowId, 'mcp_oauth', metadata);
  expect(await manager.deleteFlow(flowId, 'mcp_oauth')).toBe(true);
  expect(await cache.get(`mcp_oauth:${flowId}`)).toBeUndefined();
});

it.each(['mcp_oauth', 'mcp_get_tokens'])(
  'discards legacy plaintext %s flows in governed mode',
  async (type) => {
    const { cache, manager } = fixture();
    await cache.set(`${type}:${flowId}`, {
      type,
      status: 'COMPLETED',
      metadata,
      result: tokens,
      createdAt: Date.now(),
    });
    expect(await manager.getFlowState(flowId, type)).toBeUndefined();
    expect(await cache.get(`${type}:${flowId}`)).toBeUndefined();
    expect(await manager.completeFlow(flowId, type, tokens)).toBe(false);
  },
);

it('rejects plaintext disguised as ciphertext and ciphertext copied from another flow', async () => {
  const { cache, manager } = fixture();
  const key = `mcp_oauth:${flowId}`;
  await cache.set(key, {
    encrypted: JSON.stringify({ key, state: { type: 'mcp_oauth', metadata, result: tokens } }),
  });
  await expect(manager.getFlowState(flowId, 'mcp_oauth')).rejects.toThrow(
    'MCP flow state could not be decrypted',
  );
  await manager.initFlow(flowId, 'mcp_oauth', metadata);
  await cache.set('mcp_oauth:other-administrator:managed-connection', await cache.get(key));
  await expect(
    manager.getFlowState('other-administrator:managed-connection', 'mcp_oauth'),
  ).rejects.toThrow('MCP flow state could not be decrypted');
});

it('fails closed without caching plaintext when the credential encryption key is invalid', async () => {
  const configuredEnvironment = process.env;
  process.env = { ...configuredEnvironment, CREDS_KEY: '' };
  const cache = new Keyv();
  try {
    await jest.isolateModulesAsync(async () => {
      const { FlowStateManager } = await import('./manager');
      const manager = new FlowStateManager(cache, { ttl: 60000, ci: true });
      await expect(manager.initFlow(flowId, 'mcp_oauth', metadata)).rejects.toThrow(
        'MCP flow state could not be encrypted',
      );
      expect(await cache.get(`mcp_oauth:${flowId}`)).toBeUndefined();
    });
  } finally {
    process.env = configuredEnvironment;
  }
});

it('can read protected flows after governed mode is turned off', async () => {
  const { manager } = fixture();
  await manager.initFlow(flowId, 'mcp_oauth', metadata);
  await manager.completeFlow(flowId, 'mcp_oauth', tokens);
  process.env.GOVERNANCE_PILOT_ENABLED = 'false';
  expect(await manager.getFlowState(flowId, 'mcp_oauth')).toMatchObject({
    metadata,
    result: tokens,
  });
});

it.each([
  ['false', 'mcp_oauth'],
  ['true', 'unrelated-flow'],
])('preserves existing storage for mode %s and type %s', async (mode, type) => {
  process.env.GOVERNANCE_PILOT_ENABLED = mode;
  const { manager, serialized } = fixture();
  await manager.initFlow(flowId, type, metadata);
  await manager.completeFlow(flowId, type, tokens);
  for (const secret of secrets) expect(serialized()).toContain(secret);
  expect(await manager.getFlowState(flowId, type)).toMatchObject({ metadata, result: tokens });
});
