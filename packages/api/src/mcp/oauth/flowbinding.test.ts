import { Keyv } from 'keyv';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '~/mcp/types';
import type { MCPOAuthTokens } from './types';
import type { FlowStateManager } from '~/flow/manager';
import { InMemoryTokenStore, createOAuthMCPServer } from '../__tests__/helpers/oauthTestServer';

let Factory: typeof import('../MCPConnectionFactory').MCPConnectionFactory;
let OAuth: typeof import('./handler').MCPOAuthHandler;
let FlowManager: typeof import('~/flow/manager').FlowStateManager;
let bindingFor: typeof import('~/governance/authorization').getGovernanceMCPOAuthBinding;
const environment = process.env;
const user = { id: 'administrator', role: 'GOVERNANCE_ADMIN' } as IUser;
const serverName = 'managed-remote';

beforeAll(async () => {
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';
  Factory = (await import('../MCPConnectionFactory')).MCPConnectionFactory;
  OAuth = (await import('./handler')).MCPOAuthHandler;
  FlowManager = (await import('~/flow/manager')).FlowStateManager;
  bindingFor = (await import('~/governance/authorization')).getGovernanceMCPOAuthBinding;
});

beforeEach(() => {
  process.env = { ...process.env, GOVERNANCE_PILOT_ENABLED: 'true' };
});

afterAll(() => {
  process.env = environment;
});

function createFactory(
  config: ParsedServerConfig,
  manager: FlowStateManager<MCPOAuthTokens | null>,
  oauthStart: (url: string) => Promise<void>,
) {
  const store = new InMemoryTokenStore();
  return new (class extends Factory {
    public constructor() {
      super(
        {
          serverName,
          serverConfig: config,
          dbSourced: true,
          allowedDomains: [config.url!],
        },
        { user, useOAuth: true, flowManager: manager, tokenMethods: store, oauthStart },
      );
    }

    public loadTokens() {
      return this.getOAuthTokens();
    }

    public authorize() {
      return this.handleOAuthRequired();
    }
  })();
}

it.each([undefined, 'tenant:with/slashes'])(
  'round-trips bound OAuth flow ids for tenant %s',
  (tenant) => {
    const binding = 'a'.repeat(64);
    const bound = OAuth.generateFlowId(user.id, serverName, tenant, binding);
    const legacy = OAuth.generateFlowId(user.id, serverName, tenant);
    expect(bound).not.toBe(legacy);
    expect(OAuth.parseFlowId(bound)).toEqual({
      userId: user.id,
      serverName,
      ...(tenant && { tenantId: tenant }),
      binding,
    });
    expect(OAuth.parseFlowId(legacy)).toEqual({
      userId: user.id,
      serverName,
      ...(tenant && { tenantId: tenant }),
    });
    expect(OAuth.generateTokenFlowId(user.id, serverName, tenant, binding)).toBe(bound);
  },
);

it.each([
  ['PENDING', 'url'],
  ['COMPLETED', 'url'],
  ['PENDING', 'dbId'],
  ['COMPLETED', 'dbId'],
] as const)('does not reuse %s OAuth or token flows after changing %s', async (status, field) => {
  const remote = await createOAuthMCPServer();
  const manager = new FlowManager<MCPOAuthTokens | null>(new Keyv(), { ttl: 30000, ci: true });
  const oldConfig: ParsedServerConfig = {
    dbId: '507f1f77bcf86cd799439011',
    source: 'user',
    type: 'streamable-http',
    url: field === 'url' ? 'https://original.example/mcp' : remote.url,
    oauth: {},
    requiresOAuth: true,
  };
  const config: ParsedServerConfig = {
    ...oldConfig,
    url: remote.url,
    ...(field === 'dbId' && { dbId: '507f1f77bcf86cd799439012' }),
  };
  const oldBinding = bindingFor(oldConfig);
  const binding = bindingFor(config);
  expect(binding).toBeDefined();
  expect(binding).not.toBe(oldBinding);
  const oldTokens: MCPOAuthTokens = {
    access_token: 'old-target-authorization',
    token_type: 'Bearer',
    obtained_at: Date.now(),
    expires_at: Date.now() + 3600000,
  };
  const freshTokens = { ...oldTokens, access_token: 'fresh-target-authorization' };
  const boundId = OAuth.generateFlowId(user.id, serverName, undefined, binding);
  const oldIds = [
    OAuth.generateFlowId(user.id, serverName, undefined, oldBinding),
    OAuth.generateFlowId(user.id, serverName),
  ];
  for (const oldId of oldIds) {
    for (const type of ['mcp_oauth', 'mcp_get_tokens'] as const) {
      await manager.initFlow(oldId, type, {
        userId: user.id,
        serverName,
        serverUrl: oldConfig.url!,
        authorizationUrl: 'https://original.example/authorize',
        state: 'old-state',
        binding: oldBinding,
      });
      if (status === 'COMPLETED') await manager.completeFlow(oldId, type, oldTokens);
    }
  }
  const authorizationUrls: string[] = [];
  const factory = createFactory(config, manager, async (url) => {
    authorizationUrls.push(url);
    await manager.completeFlow(boundId, 'mcp_oauth', freshTokens);
  });
  try {
    expect(await factory.loadTokens()).toBeNull();
    const result = await factory.authorize();
    expect(result?.tokens).toEqual(freshTokens);
    expect(authorizationUrls).toHaveLength(1);
    expect(authorizationUrls[0]).toContain(remote.url);
    expect(await manager.getFlowState(boundId, 'mcp_oauth')).toMatchObject({
      metadata: { binding },
    });
    expect(remote.registeredClients.size).toBe(1);
  } finally {
    await remote.close();
  }
});
