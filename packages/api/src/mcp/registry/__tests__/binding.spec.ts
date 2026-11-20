import type { ParsedServerConfig } from '~/mcp/types';
import { requireApiKeyReentryForRebinding, prepareOAuthSecretReuse } from '../binding';

const config: ParsedServerConfig = {
  type: 'sse',
  url: 'https://example.com/',
  apiKey: {
    source: 'admin',
    authorization_type: 'custom',
    custom_header: 'X-Api-Key',
    key: 'stored-secret',
  },
  oauth: {
    client_id: 'client',
    client_secret: 'stored-oauth-secret',
    token_url: 'https://example.com/token',
    revocation_endpoint: 'https://example.com/revoke',
  },
};

it('accepts equivalent URL/header spellings and explicitly replaced keys', () => {
  expect(() =>
    requireApiKeyReentryForRebinding(config, {
      ...config,
      url: 'https://example.com',
      apiKey: { ...config.apiKey!, key: undefined, custom_header: 'x-api-key' },
    }),
  ).not.toThrow();
  expect(() =>
    requireApiKeyReentryForRebinding(config, {
      ...config,
      url: 'https://other.example',
      apiKey: { ...config.apiKey!, key: 'new-key' },
    }),
  ).not.toThrow();
});

it('preserves omitted OAuth metadata and accepts explicitly replaced secrets', () => {
  const { client_secret: _secret, revocation_endpoint: _endpoint, ...oauth } = config.oauth!;
  expect(prepareOAuthSecretReuse(config, { ...config, oauth }).oauth?.revocation_endpoint).toBe(
    config.oauth!.revocation_endpoint,
  );
  expect(() =>
    prepareOAuthSecretReuse(config, {
      ...config,
      oauth: { ...oauth, client_id: 'other', client_secret: 'new-secret' },
    }),
  ).not.toThrow();
});

it('rejects proxy changes and treats HTTP transport aliases as equivalent', () => {
  const existing: ParsedServerConfig = { ...config, type: 'streamable-http' };
  const updated: ParsedServerConfig = {
    ...existing,
    apiKey: { ...existing.apiKey!, key: undefined },
  };
  expect(() =>
    requireApiKeyReentryForRebinding(existing, { ...updated, proxy: 'https://proxy.example' }),
  ).toThrow('proxy');
  expect(() =>
    requireApiKeyReentryForRebinding(existing, { ...updated, type: 'http' }),
  ).not.toThrow();
});
