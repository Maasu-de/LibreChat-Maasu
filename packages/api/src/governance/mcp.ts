import { Constants, SystemRoles } from 'librechat-data-provider';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPManager } from '~/mcp/MCPManager';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import type { AppConfig } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '~/mcp/types';
import type { RequestHandler } from 'express';
import type { ServerRequest } from '~/types/http';
import type { MCPOptions, MCPServerUserInput } from 'librechat-data-provider';
import { isGovernancePilotEnabled } from './mode';
import { isGovernanceMCPAuditConfigured, queueGovernanceMCPAudit } from './audit';
import { createSafeUser } from '~/utils/env';

/** The administrative surface cannot expose execution, sharing, or token retrieval. */
export function isGovernanceMCPApi(method: string, path: string): boolean {
  const normalized = path.replace(/\/+$/, '');
  if (method === 'GET') {
    return (
      /^\/mcp\/servers(?:\/[^/]+(?:\/inspect)?)?$/.test(normalized) ||
      /^\/mcp\/connection\/status(?:\/[^/]+)?$/.test(normalized) ||
      /^\/mcp\/[^/]+\/oauth\/(initiate|callback)$/.test(normalized) ||
      /^\/mcp\/oauth\/status\/[^/]+$/.test(normalized)
    );
  }
  if (method === 'POST') {
    return (
      normalized === '/mcp/servers' ||
      /^\/mcp\/[^/]+\/(reinitialize|oauth\/(bind|revoke))$/.test(normalized) ||
      /^\/mcp\/oauth\/cancel\/[^/]+$/.test(normalized)
    );
  }
  return ['PATCH', 'DELETE'].includes(method) && /^\/mcp\/servers\/[^/]+$/.test(normalized);
}

export function isGovernanceRemoteMCP(config: MCPOptions | MCPServerUserInput): boolean {
  const candidate = config as MCPOptions;
  if (candidate.type !== 'streamable-http' && candidate.type !== 'http' && candidate.type !== 'sse')
    return false;
  if (!candidate.url) return false;
  if (candidate.obo || candidate.apiKey?.source === 'user' || candidate.customUserVars)
    return false;
  if ('headers' in candidate && Object.keys(candidate.headers ?? {}).length) return false;
  if ('oauth_headers' in candidate && Object.keys(candidate.oauth_headers ?? {}).length)
    return false;
  return [
    candidate.url,
    candidate.oauth?.authorization_url,
    candidate.oauth?.token_url,
    candidate.oauth?.revocation_endpoint,
    candidate.oauth?.redirect_uri,
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .every((value) => {
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    });
}

export function preserveGovernanceMCPSecrets(
  config: ParsedServerConfig,
  existing?: ParsedServerConfig,
): ParsedServerConfig {
  if (!isGovernancePilotEnabled()) return config;
  return {
    ...config,
    ...(config.apiKey?.source === 'admin' &&
    !config.apiKey.key &&
    existing?.apiKey?.source === 'admin' &&
    existing.apiKey.key
      ? { apiKey: { ...config.apiKey, key: existing.apiKey.key } }
      : {}),
    ...(config.oauth && !config.oauth.client_secret && existing?.oauth?.client_secret
      ? { oauth: { ...config.oauth, client_secret: existing.oauth.client_secret } }
      : {}),
  };
}

export const requireGovernanceMCPAdministrator: RequestHandler = (req, res, next) => {
  if (!isGovernancePilotEnabled()) return next();
  const request = req as ServerRequest;
  if (request.user?.provider !== 'openid' || request.user.role !== SystemRoles.GOVERNANCE_ADMIN) {
    res.status(403).json({ message: 'OIDC administrator entitlement required' });
    return;
  }
  if (!isGovernanceMCPAuditConfigured(request)) {
    res.status(503).json({ message: 'MCP administration audit is unavailable' });
    return;
  }
  next();
};

interface GovernanceMCPDependencies {
  getRegistry: () => Pick<MCPServersRegistry, 'getServerConfig'>;
  getManager: () => Pick<MCPManager, 'disconnectUserConnection'>;
  reinitialize: (params: {
    user: ReturnType<typeof createSafeUser>;
    serverName: string;
    serverConfig: ParsedServerConfig;
  }) => Promise<
    { success: boolean; oauthRequired: boolean; tools: Tool[] | null } | null | undefined
  >;
  revoke: (userId: string, pluginKey: string, appConfig?: AppConfig) => Promise<void>;
}

export function createGovernanceMCPHandlers(deps: GovernanceMCPDependencies): {
  inspect: RequestHandler<{ serverName: string }>;
  revoke: RequestHandler<{ serverName: string }>;
} {
  const inspect: RequestHandler<{ serverName: string }> = async (req, res) => {
    const request = req as ServerRequest;
    const { serverName } = req.params;
    let config: ParsedServerConfig | undefined;
    try {
      config = await deps.getRegistry().getServerConfig(serverName, request.user?.id);
      if (!config?.dbId || !isGovernanceRemoteMCP(config)) {
        res.status(404).json({ message: 'MCP connection not found' });
        return;
      }
      const result = await deps.reinitialize({
        user: createSafeUser(request.user),
        serverName,
        serverConfig: config,
      });
      const success = Boolean(result?.success && !result.oauthRequired);
      await queueGovernanceMCPAudit(
        request,
        'mcp.inspected',
        config.dbId,
        success ? 'success' : 'failure',
      );
      res.json({
        success,
        tools: success
          ? (result?.tools ?? []).map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            }))
          : [],
      });
    } catch {
      if (config?.dbId)
        await queueGovernanceMCPAudit(request, 'mcp.inspected', config.dbId, 'failure');
      res
        .status(500)
        .json({ success: false, tools: [], message: 'MCP connection inspection failed' });
    }
  };
  const revoke: RequestHandler<{ serverName: string }> = async (req, res) => {
    const request = req as ServerRequest;
    const { serverName } = req.params;
    let config: ParsedServerConfig | undefined;
    try {
      config = await deps.getRegistry().getServerConfig(serverName, request.user?.id);
      if (!config?.dbId || !request.user?.id) {
        res.status(404).json({ message: 'MCP connection not found' });
        return;
      }
      await deps.revoke(request.user.id, `${Constants.mcp_prefix}${serverName}`, request.config);
      await deps.getManager().disconnectUserConnection(request.user.id, serverName);
      await queueGovernanceMCPAudit(request, 'mcp.oauth.revoked', config.dbId);
      res.json({ success: true });
    } catch {
      if (config?.dbId)
        await queueGovernanceMCPAudit(request, 'mcp.oauth.revoked', config.dbId, 'failure');
      res.status(500).json({ message: 'MCP OAuth revocation failed' });
    }
  };
  return { inspect, revoke };
}
