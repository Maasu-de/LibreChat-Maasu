import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { getTenantId, logger, createMCPGovernanceIdentityModel } from '@librechat/data-schemas';
import type { MCPTool, ParsedServerConfig } from './types';
import type { MCPConnection } from './connection';

const SECRET_NAME =
  /(?:token|secret|password|passwd|credential|api[_-]?key|authorization|signature|session|cookie)|^(?:key|sig|code)$/i;

export interface MCPGovernanceDefinition {
  endpoint?: string;
  proxy?: string;
  transport: ParsedServerConfig['type'];
  authentication: {
    mode: string;
    authorization_type?: string;
    header_name?: string;
    header_names?: string[];
    oauth?: Pick<
      NonNullable<ParsedServerConfig['oauth']>,
      | 'authorization_url'
      | 'token_url'
      | 'client_id'
      | 'audience'
      | 'redirect_uri'
      | 'token_exchange_method'
      | 'grant_types_supported'
      | 'token_endpoint_auth_methods_supported'
      | 'response_types_supported'
      | 'code_challenge_methods_supported'
      | 'skip_code_challenge_check'
    >;
  };
  authorization_scope: string[];
  server_instructions?: ParsedServerConfig['serverInstructions'];
  command?: string;
  args?: string[];
}

function nonSecretMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nonSecretMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_NAME.test(key))
      .map(([key, item]) => [key, nonSecretMetadata(item)]),
  );
}

export function governanceToolDefinition(tool: MCPTool): MCPTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: nonSecretMetadata(tool.annotations) as MCPTool['annotations'],
    execution: nonSecretMetadata(tool.execution) as MCPTool['execution'],
    ...(tool._meta && { _meta: nonSecretMetadata(tool._meta) as MCPTool['_meta'] }),
  };
}

export function governanceUrl(value?: string): string | undefined {
  if (value == null) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_NAME.test(name)) url.searchParams.set(name, '[REDACTED]');
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

function nonSecretArgs(args: string[]): string[] {
  let omitNext = false;
  let headerNext = false;
  const redactHeader = (header: string): string => {
    const colon = header.indexOf(':');
    if (colon < 0) return '[REDACTED]';
    const name = header.slice(0, colon).trim();
    const scheme = header
      .slice(colon + 1)
      .trim()
      .split(/\s+/, 1)[0];
    const mode =
      name.toLowerCase() === 'authorization' && /^(?:basic|bearer)$/i.test(scheme)
        ? `${scheme.toLowerCase()} `
        : '';
    return `${name.toLowerCase()}: ${mode}[REDACTED]`;
  };
  return args.flatMap((arg) => {
    if (headerNext) {
      headerNext = false;
      return [redactHeader(arg)];
    }
    if (/^(?:--header|-H)$/.test(arg)) {
      headerNext = true;
      return [arg];
    }
    if (/^(?:--header|-H)=/.test(arg)) {
      const equals = arg.indexOf('=');
      return [`${arg.slice(0, equals + 1)}${redactHeader(arg.slice(equals + 1))}`];
    }
    if (omitNext) {
      omitNext = false;
      return [];
    }
    if (
      (arg.startsWith('-') && SECRET_NAME.test(arg.split('=')[0])) ||
      /^(?:--headers?|--env|-H|-e|-u|--user|--proxy-user|-b)(?:=|$)/.test(arg)
    ) {
      omitNext = !arg.includes('=');
      return [];
    }
    if (SECRET_NAME.test(arg.split(/[:=]/)[0]) && /[:=]/.test(arg)) return [];
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(arg)) return governanceUrl(arg) ?? [];
    return [arg];
  });
}

function authenticationMode(config: ParsedServerConfig): string {
  if (config.obo) return 'obo';
  if (config.apiKey) return 'api_key';
  if (config.requiresOAuth || config.oauth) return 'oauth';
  if ('headers' in config && config.headers && Object.keys(config.headers).length > 0)
    return 'headers';
  if (config.customUserVars && Object.keys(config.customUserVars).length > 0) return 'custom';
  return 'none';
}

export function observedMCPConfig(
  config: ParsedServerConfig,
  connection: MCPConnection,
): ParsedServerConfig {
  if (config.remoteServerInstructions || config.serverInstructions === true) {
    return { ...config, serverInstructions: connection.client.getInstructions() ?? '' };
  }
  return config;
}

/** Only non-secret fields participate in the gateway's connection fingerprint. */
export function governanceDefinition(config: ParsedServerConfig): MCPGovernanceDefinition {
  const oauth = config.oauth;
  const headers = 'headers' in config ? config.headers : undefined;
  const authorization = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'authorization',
  );
  const scheme = authorization?.[1].trim().split(/\s+/, 1)[0].toLowerCase();
  const scopes = config.obo?.scopes ?? oauth?.scope;
  return {
    endpoint: governanceUrl(config.url),
    ...('proxy' in config && { proxy: governanceUrl(config.proxy) }),
    transport: config.type === 'http' ? 'streamable-http' : config.type,
    authentication: {
      mode: authenticationMode(config),
      authorization_type:
        config.apiKey?.authorization_type ??
        (scheme === 'basic' || scheme === 'bearer' ? scheme : undefined),
      header_name: config.apiKey?.custom_header,
      ...(headers && {
        header_names: Object.keys(headers)
          .map((name) => name.toLowerCase())
          .sort(),
      }),
      ...(oauth && {
        oauth: {
          authorization_url: governanceUrl(oauth.authorization_url),
          token_url: governanceUrl(oauth.token_url),
          client_id: oauth.client_id,
          audience: oauth.audience,
          redirect_uri: governanceUrl(oauth.redirect_uri),
          token_exchange_method: oauth.token_exchange_method,
          grant_types_supported: oauth.grant_types_supported,
          token_endpoint_auth_methods_supported: oauth.token_endpoint_auth_methods_supported,
          response_types_supported: oauth.response_types_supported,
          code_challenge_methods_supported: oauth.code_challenge_methods_supported,
          skip_code_challenge_check: oauth.skip_code_challenge_check,
        },
      }),
    },
    authorization_scope: scopes ? [...new Set(scopes.split(/\s+/).filter(Boolean))].sort() : [],
    server_instructions: config.serverInstructions,
    ...(config.type === 'stdio' && {
      command: config.command,
      args: nonSecretArgs(config.args),
    }),
  };
}

export async function governanceConnectionId(
  serverName: string,
  config: ParsedServerConfig,
): Promise<string> {
  if (config.dbId) return config.dbId;
  if (config.source === 'user') {
    const server = await mongoose.models.MCPServer.findOne({ serverName })
      .select('_id')
      .lean<{ _id: mongoose.Types.ObjectId }>();
    if (!server) throw new Error('MCP connection reference unavailable');
    return String(server._id);
  }
  const Identity = createMCPGovernanceIdentityModel(mongoose);
  const key = {
    tenantId: getTenantId() ?? process.env.PILOT_TENANT_ID ?? 'default',
    source: 'operator',
    serverName,
  };
  const id = new mongoose.Types.ObjectId(
    createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 24),
  );
  const identity = await Identity.findOneAndUpdate(
    { _id: id },
    { $setOnInsert: key },
    { upsert: true, new: true },
  ).lean();
  return String(identity._id);
}

/** Reuses inspection/discovery results; never connects to or executes an MCP server. */
export async function publishMCPGovernance(
  serverName: string,
  config: ParsedServerConfig,
  tools?: MCPTool[] | null,
  userId?: string,
  available = true,
): Promise<void> {
  const baseUrl = process.env.GOVERNANCE_MCP_METADATA_URL;
  const credential = process.env.LIBRECHAT_SERVICE_CREDENTIAL;
  if (!baseUrl || !credential) return;
  try {
    const id = await governanceConnectionId(serverName, config);
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: serverName,
        definition: governanceDefinition(config),
        tools: tools?.map(governanceToolDefinition) ?? tools,
        source: 'librechat',
        available,
        ...(userId && { actor: { issuer: 'librechat', user_id: userId } }),
      }),
    });
    if (!response.ok) throw new Error('MCP governance publication failed');
  } catch {
    logger.warn('[MCP Governance] Could not update connection metadata');
  }
}
