import type { MCPOptions, ParsedServerConfig } from '~/mcp/types';
import { MCPApiKeyReentryRequiredError, MCPOAuthSecretReentryRequiredError } from '~/mcp/errors';

function getUrl(config: MCPOptions): string | undefined {
  return 'url' in config ? config.url : undefined;
}

function getProxy(config: MCPOptions): string | undefined {
  return 'proxy' in config ? config.proxy : undefined;
}

function normalizeUrl(value?: string): string | undefined {
  if (!value) {
    return value;
  }

  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function normalizeTransport(type: MCPOptions['type']): string {
  return type === 'http' ? 'streamable-http' : type;
}

function normalizeCustomHeader(apiKey: MCPOptions['apiKey']): string | undefined {
  if (apiKey?.authorization_type !== 'custom') {
    return undefined;
  }
  return (apiKey.custom_header || 'X-Api-Key').toLowerCase();
}

/** Returns fields that would move an omitted, stored admin key to a new request boundary. */
export function getChangedApiKeyBindingFields(
  existingConfig: MCPOptions,
  updatedConfig: MCPOptions,
): string[] {
  const existingApiKey = existingConfig.apiKey;
  const updatedApiKey = updatedConfig.apiKey;
  const preservesStoredKey =
    existingApiKey?.source === 'admin' &&
    !!existingApiKey.key &&
    updatedApiKey?.source === 'admin' &&
    !updatedApiKey.key;

  if (!preservesStoredKey) {
    return [];
  }

  const fields = [
    ['url', normalizeUrl(getUrl(existingConfig)), normalizeUrl(getUrl(updatedConfig))],
    ['type', normalizeTransport(existingConfig.type), normalizeTransport(updatedConfig.type)],
    ['proxy', normalizeUrl(getProxy(existingConfig)), normalizeUrl(getProxy(updatedConfig))],
    [
      'apiKey.authorization_type',
      existingApiKey.authorization_type,
      updatedApiKey.authorization_type,
    ],
    [
      'apiKey.custom_header',
      normalizeCustomHeader(existingApiKey),
      normalizeCustomHeader(updatedApiKey),
    ],
  ] as const;

  return fields.filter(([, existing, updated]) => existing !== updated).map(([field]) => field);
}

/** Requires a replacement key before a stored admin credential can cross request boundaries. */
export function requireApiKeyReentryForRebinding(
  existingConfig: MCPOptions,
  updatedConfig: MCPOptions,
): void {
  const changedFields = getChangedApiKeyBindingFields(existingConfig, updatedConfig);
  if (changedFields.length > 0) {
    throw new MCPApiKeyReentryRequiredError(changedFields);
  }
}

type OAuthConfig = NonNullable<MCPOptions['oauth']>;

function normalizeOAuthUrl(value?: string): string | undefined {
  if (!value) {
    return value;
  }

  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function normalizeOAuthMethods(values?: readonly string[]): string | undefined {
  if (!values?.length) {
    return undefined;
  }
  return JSON.stringify([...new Set(values)].sort());
}

export function preserveOmittedOAuthBindingFields(
  existingOAuth: OAuthConfig,
  updatedOAuth: OAuthConfig,
): OAuthConfig {
  return {
    ...updatedOAuth,
    ...(updatedOAuth.token_endpoint_auth_methods_supported === undefined &&
      existingOAuth.token_endpoint_auth_methods_supported !== undefined && {
        token_endpoint_auth_methods_supported: existingOAuth.token_endpoint_auth_methods_supported,
      }),
    ...(updatedOAuth.revocation_endpoint === undefined &&
      existingOAuth.revocation_endpoint !== undefined && {
        revocation_endpoint: existingOAuth.revocation_endpoint,
      }),
    ...(updatedOAuth.revocation_endpoint_auth_methods_supported === undefined &&
      existingOAuth.revocation_endpoint_auth_methods_supported !== undefined && {
        revocation_endpoint_auth_methods_supported:
          existingOAuth.revocation_endpoint_auth_methods_supported,
      }),
  };
}

function getChangedOAuthSecretBindingFields(
  existingConfig: MCPOptions,
  updatedConfig: MCPOptions,
): string[] {
  const existingOAuth = existingConfig.oauth;
  const updatedOAuth = updatedConfig.oauth;
  if (!existingOAuth || !updatedOAuth) {
    return [];
  }

  const fields = [
    [
      'url',
      normalizeOAuthUrl('url' in existingConfig ? existingConfig.url : undefined),
      normalizeOAuthUrl(getUrl(updatedConfig)),
    ],
    [
      'oauth.authorization_url',
      normalizeOAuthUrl(existingOAuth.authorization_url),
      normalizeOAuthUrl(updatedOAuth.authorization_url),
    ],
    [
      'oauth.token_url',
      normalizeOAuthUrl(existingOAuth.token_url),
      normalizeOAuthUrl(updatedOAuth.token_url),
    ],
    ['oauth.client_id', existingOAuth.client_id, updatedOAuth.client_id],
    [
      'oauth.token_exchange_method',
      existingOAuth.token_exchange_method,
      updatedOAuth.token_exchange_method,
    ],
    [
      'oauth.token_endpoint_auth_methods_supported',
      normalizeOAuthMethods(existingOAuth.token_endpoint_auth_methods_supported),
      normalizeOAuthMethods(updatedOAuth.token_endpoint_auth_methods_supported),
    ],
    [
      'oauth.revocation_endpoint',
      normalizeOAuthUrl(existingOAuth.revocation_endpoint),
      normalizeOAuthUrl(updatedOAuth.revocation_endpoint),
    ],
    [
      'oauth.revocation_endpoint_auth_methods_supported',
      normalizeOAuthMethods(existingOAuth.revocation_endpoint_auth_methods_supported),
      normalizeOAuthMethods(updatedOAuth.revocation_endpoint_auth_methods_supported),
    ],
  ] as const;

  return fields.filter(([, existing, updated]) => existing !== updated).map(([field]) => field);
}

export function prepareOAuthSecretReuse(
  existing: MCPOptions,
  updated: ParsedServerConfig,
): ParsedServerConfig {
  if (!existing.oauth?.client_secret || !updated.oauth || updated.oauth.client_secret)
    return updated;
  const candidate = {
    ...updated,
    oauth: preserveOmittedOAuthBindingFields(existing.oauth, updated.oauth),
  };
  const changedFields = getChangedOAuthSecretBindingFields(existing, candidate);
  if (changedFields.length) throw new MCPOAuthSecretReentryRequiredError(changedFields);
  return candidate;
}
