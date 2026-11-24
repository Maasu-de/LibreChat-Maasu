import { getTenantId } from '@librechat/data-schemas';
import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import type { ParsedServerConfig } from '~/mcp/types';
import { getGovernanceMCPOAuthBinding } from './authorization';
import type { isGovernanceMCPOAuthAuthorized } from './oauth';
import { isGovernanceRemoteMCP } from './mcp';

export async function getGovernanceMCPConfigs(
  registry: Pick<MCPServersRegistry, 'getAllServerConfigs'>,
  userId: string,
  role?: string,
): Promise<Record<string, ParsedServerConfig>> {
  const configs = await registry.getAllServerConfigs(userId, undefined, role);
  return Object.fromEntries(
    Object.entries(configs).filter(([, config]) => config.dbId && isGovernanceRemoteMCP(config)),
  );
}

interface GovernanceMCPStatusDependencies {
  isAuthorized: typeof isGovernanceMCPOAuthAuthorized;
  isReconnecting: (userId: string, serverName: string) => boolean;
  checkFlowStatus: (
    userId: string,
    serverName: string,
    tenantId?: string,
    binding?: string,
  ) => Promise<{
    hasActiveFlow: boolean;
    hasFailedFlow: boolean;
  }>;
}

export async function getGovernanceMCPConnectionStatus(
  userId: string,
  serverName: string,
  config: ParsedServerConfig,
  connection: Pick<MCPServerStatus, 'connectionState'> & { stale: boolean },
  requiresOAuth: boolean,
  deps: GovernanceMCPStatusDependencies,
): Promise<MCPServerStatus> {
  const binding = getGovernanceMCPOAuthBinding(config);
  const authorizationComplete =
    requiresOAuth && config.dbId
      ? await deps.isAuthorized(userId, config.dbId, binding)
      : undefined;
  let connectionState =
    connection.stale || authorizationComplete === false
      ? ('disconnected' as const)
      : connection.connectionState || 'disconnected';
  if (connectionState === 'disconnected' && requiresOAuth && !authorizationComplete) {
    if (deps.isReconnecting(userId, serverName)) {
      connectionState = 'connecting';
    } else {
      const { hasActiveFlow, hasFailedFlow } = await deps.checkFlowStatus(
        userId,
        serverName,
        getTenantId(),
        binding,
      );
      if (hasFailedFlow) connectionState = 'error';
      else if (hasActiveFlow) connectionState = 'connecting';
    }
  }
  return {
    requiresOAuth,
    connectionState,
    ...(authorizationComplete != null ? { authorizationComplete } : {}),
  };
}
