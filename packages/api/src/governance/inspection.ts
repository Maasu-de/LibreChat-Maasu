import { logger } from '@librechat/data-schemas';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import type { ParsedServerConfig, ToolDiscoveryResult } from '~/mcp/types';
import type { MCPManager } from '~/mcp/MCPManager';
import type { RequestHandler } from 'express';
import type { ServerRequest } from '~/types/http';
import type { queueGovernanceMCPAudit } from './audit';
import { isGovernanceRemoteMCP } from './mcp';
import { createSafeUser } from '~/utils/env';
import { setOAuthCsrfCookie } from '~/oauth/csrf';

type InitializationResult = Pick<ToolDiscoveryResult, 'oauthRequired' | 'oauthUrl'> & {
  success: boolean;
};

interface GovernanceMCPReinitializationDependencies {
  getRegistry: () => Pick<MCPServersRegistry, 'getServerConfig'>;
  getManager: () => Pick<MCPManager, 'disconnectUserConnection'>;
  reinitialize: (params: {
    user: ReturnType<typeof createSafeUser>;
    serverName: string;
    serverConfig: ParsedServerConfig;
    configServers?: undefined;
    userMCPAuthMap?: undefined;
  }) => Promise<InitializationResult | undefined>;
  getFlowId: (userId: string, serverName: string) => Promise<string>;
  queueAudit: typeof queueGovernanceMCPAudit;
}

export function createGovernanceMCPReinitialization(
  deps: GovernanceMCPReinitializationDependencies,
): RequestHandler<{ serverName: string }> {
  return async (req, res) => {
    const request = req as ServerRequest;
    const { serverName } = req.params;
    const user = createSafeUser(request.user);
    if (!user.id) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }
    try {
      const config = await deps.getRegistry().getServerConfig(serverName, user.id);
      if (!config?.dbId || !isGovernanceRemoteMCP(config)) {
        res.status(404).json({ error: `MCP server '${serverName}' not found in configuration` });
        return;
      }
      await deps.getManager().disconnectUserConnection(user.id, serverName);
      const result = await deps.reinitialize({
        user,
        serverName,
        serverConfig: config,
        configServers: undefined,
        userMCPAuthMap: undefined,
      });
      if (!result) {
        await deps.queueAudit(request, 'mcp.inspected', config.dbId, 'failure');
        res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
        return;
      }
      const { success, oauthRequired, oauthUrl } = result;
      await deps.queueAudit(
        request,
        'mcp.inspected',
        config.dbId,
        success && !oauthRequired ? 'success' : 'failure',
      );
      if (oauthRequired) {
        setOAuthCsrfCookie(res, await deps.getFlowId(user.id, serverName), '/api/mcp');
      }
      res.json({
        success,
        message: success ? 'Connection inspected' : 'Connection inspection failed',
        oauthUrl,
        serverName,
        oauthRequired,
      });
    } catch {
      logger.error('[MCP Reinitialize] Unexpected error', 'MCP operation failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
