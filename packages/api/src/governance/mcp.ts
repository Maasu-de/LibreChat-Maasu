import { getTenantId, tenantStorage, logger } from '@librechat/data-schemas';
import { Constants, SystemRoles } from 'librechat-data-provider';
import type { MCPManager } from '~/mcp/MCPManager';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import type { AppConfig, AllMethods } from '@librechat/data-schemas';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import type { FlowStateManager } from '~/flow/manager';
import type { ZodIssue } from 'zod';
import type { ParsedServerConfig, ToolDiscoveryResult } from '~/mcp/types';
import type { RequestHandler, Response } from 'express';
import type { ClientSession } from 'mongoose';
import type { ServerRequest } from '~/types/http';
import type { MCPOptions, MCPServerUserInput } from 'librechat-data-provider';
import { isGovernancePilotEnabled } from './mode';
import {
  isGovernanceMCPAuditConfigured,
  queueGovernanceMCPAudit,
  mutateGovernanceMCP,
  recordGovernanceMCPFailure,
} from './audit';
import { createSafeUser } from '~/utils/env';
import { MCPOAuthHandler, MCPTokenStorage } from '~/mcp/oauth';
import { validateOAuthCsrf, validateOAuthSession } from '~/oauth/csrf';
import { PENDING_STALE_MS } from '~/flow/manager';
import { getBasePath } from '~/utils/path';
import {
  getGovernanceMCPOAuthGeneration,
  claimGovernanceMCPOAuthGeneration,
  advanceGovernanceMCPOAuthGeneration,
} from './oauth';

const routingQueryParameters = new Set(['tenant', 'api-version', 'toolset']);

function isGovernanceMCPUrl(value: string, allowRoutingParameters = false): boolean {
  try {
    const url = new URL(value);
    const allowedQuery = allowRoutingParameters
      ? Array.from(url.searchParams.keys()).every((name) => routingQueryParameters.has(name))
      : !url.search;
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      allowedQuery &&
      !url.hash
    );
  } catch {
    return false;
  }
}

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
  if (!isGovernanceMCPUrl(candidate.url, true)) return false;
  return [
    candidate.oauth?.authorization_url,
    candidate.oauth?.token_url,
    candidate.oauth?.revocation_endpoint,
    candidate.oauth?.redirect_uri,
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .every((value) => isGovernanceMCPUrl(value));
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

export const requireGovernanceMCPAdministration: RequestHandler = (req, res, next) => {
  if (!isGovernancePilotEnabled()) {
    res.sendStatus(404);
    return;
  }
  requireGovernanceMCPAdministrator(req, res, next);
};

export async function storeGovernanceMCPOAuth(
  req: ServerRequest,
  connectionId: string,
  params: Parameters<typeof MCPTokenStorage.storeTokens>[0],
  generation: number,
): Promise<void> {
  await mutateGovernanceMCP(
    req,
    'mcp.oauth.authorized',
    async (session) => {
      if (session) {
        await claimGovernanceMCPOAuthGeneration(
          params.userId,
          connectionId,
          generation,
          session,
          params.binding,
        );
      }
      await MCPTokenStorage.storeTokens({
        ...params,
        ...(session && {
          createToken: (token) => params.createToken(token, session),
          updateToken: params.updateToken
            ? (query, token) => params.updateToken!(query, token, session)
            : undefined,
          findToken: params.findToken
            ? (query, options) => params.findToken!(query, { ...options, session })
            : undefined,
        }),
      });
    },
    connectionId,
  );
}

interface GovernanceMCPDependencies {
  getRegistry: () => Pick<MCPServersRegistry, 'getServerConfig'>;
  getManager: () => Pick<MCPManager, 'disconnectUserConnection'>;
  discover: (params: {
    user: ReturnType<typeof createSafeUser>;
    serverName: string;
    serverConfig: ParsedServerConfig;
  }) => Promise<ToolDiscoveryResult>;
  revoke: (
    userId: string,
    pluginKey: string,
    appConfig?: AppConfig,
    commitTokenDeletion?: (operation: (session?: ClientSession) => Promise<void>) => Promise<void>,
  ) => Promise<void>;
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
      const result = await deps.discover({
        user: createSafeUser(request.user),
        serverName,
        serverConfig: config,
      });
      const success = result.tools != null && !result.oauthRequired;
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
      await recordGovernanceMCPFailure(request, 'mcp.inspected', config?.dbId);
      res
        .status(500)
        .json({ success: false, tools: [], message: 'MCP connection inspection failed' });
    }
  };
  const revoke: RequestHandler<{ serverName: string }> = async (req, res) => {
    const request = req as ServerRequest;
    const { serverName } = req.params;
    let config: ParsedServerConfig | undefined;
    let revocationCommitted = false;
    try {
      config = await deps.getRegistry().getServerConfig(serverName, request.user?.id);
      if (!config?.dbId || !request.user?.id) {
        res.status(404).json({ message: 'MCP connection not found' });
        return;
      }
      const userId = request.user.id;
      const connectionId = config.dbId;
      if (isGovernancePilotEnabled()) {
        await getGovernanceMCPOAuthGeneration(userId, connectionId);
        await deps.revoke(
          userId,
          `${Constants.mcp_prefix}${serverName}`,
          request.config,
          async (operation) => {
            await mutateGovernanceMCP(
              request,
              'mcp.oauth.revoked',
              async (session) => {
                if (!session) throw new Error('MCP OAuth revocation requires a transaction');
                await advanceGovernanceMCPOAuthGeneration(userId, connectionId, session);
                await deps.getManager().disconnectUserConnection(userId, serverName);
                await operation(session);
              },
              connectionId,
            );
            revocationCommitted = true;
          },
        );
      } else {
        await deps.revoke(userId, `${Constants.mcp_prefix}${serverName}`, request.config);
        await deps.getManager().disconnectUserConnection(userId, serverName);
      }
      res.json({ success: true });
    } catch {
      if (revocationCommitted) {
        logger.warn('[Governance MCP] Provider revocation cleanup remains pending');
        res.json({ success: true });
        return;
      }
      await recordGovernanceMCPFailure(request, 'mcp.oauth.revoked', config?.dbId);
      res.status(500).json({ message: 'MCP OAuth revocation failed' });
    }
  };
  return { inspect, revoke };
}

interface GovernanceMCPOAuthFailureDependencies {
  getFlowManager: () => FlowStateManager<MCPOAuthTokens | null>;
  findUser: AllMethods['findUser'];
  getServerConfig: MCPServersRegistry['getServerConfig'];
}

/** Only a browser-bound, pending administrator flow may produce a failed authorization event. */
export function createGovernanceMCPOAuthFailureHandler(
  deps: GovernanceMCPOAuthFailureDependencies,
): RequestHandler<{ serverName: string }> {
  return async (req, res) => {
    const redirect = `${getBasePath()}/oauth/error?error=`;
    const { state, error } = req.query;
    const { serverName } = req.params;
    try {
      if (typeof state !== 'string' || !state || typeof error !== 'string' || !error) {
        res.redirect(`${redirect}authorization_failed`);
        return;
      }
      const manager = deps.getFlowManager();
      const flowId = await MCPOAuthHandler.resolveStateToFlowId(state, manager);
      const parsed = flowId ? MCPOAuthHandler.parseFlowId(flowId) : null;
      if (!flowId || !parsed || parsed.userId === 'system' || parsed.serverName !== serverName) {
        res.redirect(`${redirect}authorization_failed`);
        return;
      }
      const flow = await manager.getFlowState(flowId, 'mcp_oauth');
      const age = flow ? Date.now() - flow.createdAt : Infinity;
      const tenantId = getTenantId();
      if (
        !flow ||
        flow.type !== 'mcp_oauth' ||
        flow.status !== 'PENDING' ||
        !Number.isFinite(age) ||
        age < 0 ||
        age >= PENDING_STALE_MS ||
        flow.metadata.state !== state ||
        flow.metadata.userId !== parsed.userId ||
        flow.metadata.serverName !== serverName ||
        flow.metadata.tenantId !== parsed.tenantId ||
        (tenantId && tenantId !== parsed.tenantId)
      ) {
        res.redirect(`${redirect}authorization_failed`);
        return;
      }
      const browserBound =
        validateOAuthCsrf(req, res, flowId, '/api/mcp') || validateOAuthSession(req, parsed.userId);
      if (!browserBound) {
        res.redirect(`${redirect}authorization_failed`);
        return;
      }
      const fail = async () => {
        const actor = await deps.findUser({ _id: parsed.userId });
        const connection = await deps.getServerConfig(serverName, parsed.userId);
        if (
          actor?.provider !== 'openid' ||
          actor.role !== SystemRoles.GOVERNANCE_ADMIN ||
          !connection?.dbId ||
          !isGovernanceRemoteMCP(connection)
        )
          return;
        await queueGovernanceMCPAudit(
          { user: actor } as ServerRequest,
          'mcp.oauth.authorized',
          connection.dbId,
          'failure',
        );
        await manager.failFlow(flowId, 'mcp_oauth', 'authorization_failed');
      };
      if (parsed.tenantId && !tenantId)
        await tenantStorage.run({ tenantId: parsed.tenantId }, fail);
      else await fail();
      res.redirect(`${redirect}authorization_failed`);
    } catch {
      logger.warn('[Governance MCP] Failed authorization could not be recorded');
      res.redirect(`${redirect}callback_failed`);
    }
  };
}

export async function rejectGovernanceMCPUpdate(
  req: ServerRequest,
  res: Response,
  error: { error?: string; message: string; errors?: ZodIssue[] },
  connectionId?: string,
): Promise<void> {
  if (isGovernancePilotEnabled() && connectionId) {
    try {
      await queueGovernanceMCPAudit(req, 'mcp.updated', connectionId, 'failure');
    } catch {
      logger.warn('[Governance MCP] Rejected update could not be recorded');
      res.status(503).json({ message: 'MCP administration audit is unavailable' });
      return;
    }
  }
  res.status(400).json(error);
}
