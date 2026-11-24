import { getTenantId, logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import type { AppConfig, TokenMethods } from '@librechat/data-schemas';
import type { MCPProviderRevocation } from 'librechat-data-provider';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPServersRegistry } from './registry/MCPServersRegistry';
import type { ParsedServerConfig } from './types';
import type { getGovernanceMCPOAuthBinding } from '~/governance/authorization';
import { isGovernancePilotEnabled } from '~/governance/mode';
import type { MCPOAuthHandler, MCPTokenStorage } from './oauth';
import { mergeMCPRevocationFailure } from './revocation';
import { sanitizeMCPErrorForLogging } from './utils';

type TokenCommit = NonNullable<Parameters<typeof MCPTokenStorage.getTokens>[0]['commitTokens']>;
type DisconnectConfig = AppConfig & { mcpServers?: Record<string, ParsedServerConfig> };

interface MCPOAuthDisconnectDependencies {
  getRegistry: () => Pick<MCPServersRegistry, 'getServerConfig' | 'getOAuthServers'>;
  getFlowManager: () => Pick<FlowStateManager, 'deleteFlow'>;
  tokenMethods: Pick<TokenMethods, 'findToken' | 'deleteTokens'>;
  handler: Pick<
    typeof MCPOAuthHandler,
    'generateFlowId' | 'generateTokenFlowId' | 'revokeOAuthToken'
  >;
  storage: Pick<
    typeof MCPTokenStorage,
    'getClientInfoAndMetadata' | 'getTokensForRevocation' | 'deleteUserTokens'
  >;
  getBinding: typeof getGovernanceMCPOAuthBinding;
}

export function createMCPOAuthDisconnect(
  deps: MCPOAuthDisconnectDependencies,
): (
  userId: string,
  pluginKey: string,
  appConfig?: DisconnectConfig,
  commitTokenDeletion?: TokenCommit,
) => Promise<MCPProviderRevocation | void> {
  const clearStoredState = async (
    userId: string,
    serverName: string,
    commitTokenDeletion?: TokenCommit,
    binding?: string,
  ): Promise<void> => {
    const deleteStoredTokens: Parameters<TokenCommit>[0] = async (session) => {
      await deps.storage.deleteUserTokens({
        userId,
        serverName,
        ...(binding ? { binding } : {}),
        deleteToken: async (filter) => {
          await deps.tokenMethods.deleteTokens(filter, ...(session ? [session] : []));
        },
      });
    };
    if (!commitTokenDeletion) {
      try {
        await deleteStoredTokens();
      } catch (error) {
        if (isGovernancePilotEnabled()) throw new Error('Failed to clear MCP OAuth authorization');
        logger.warn(
          `[clearStoredMCPOAuthState] Failed to delete MCP OAuth tokens for ${serverName}:`,
          sanitizeMCPErrorForLogging(error),
        );
      }
    }
    const clearFlows = async () => {
      try {
        const manager = deps.getFlowManager();
        const baseFlowId = deps.handler.generateFlowId(userId, serverName);
        const tenantId = getTenantId();
        const tokenFlowId = deps.handler.generateTokenFlowId(
          userId,
          serverName,
          tenantId,
          ...(binding ? [binding] : []),
        );
        const oauthFlowId = deps.handler.generateFlowId(
          userId,
          serverName,
          tenantId,
          ...(binding ? [binding] : []),
        );
        const flowDeletes = [
          [tokenFlowId, 'mcp_get_tokens'],
          [oauthFlowId, 'mcp_oauth'],
          [baseFlowId, 'mcp_get_tokens'],
          [baseFlowId, 'mcp_oauth'],
        ].filter(
          ([flowId, type], index, deletes) =>
            deletes.findIndex(
              ([candidateId, candidateType]) => candidateId === flowId && candidateType === type,
            ) === index,
        );
        const results = await Promise.allSettled(
          flowDeletes.map(([flowId, type]) => manager.deleteFlow(flowId, type)),
        );
        for (const result of results) {
          if (
            isGovernancePilotEnabled() &&
            (result.status === 'rejected' || result.value === false)
          ) {
            throw new Error('Failed to clear MCP OAuth authorization');
          }
          if (result.status === 'rejected') {
            logger.warn(
              `[clearStoredMCPOAuthState] Failed to clear MCP OAuth flow state for ${serverName}:`,
              sanitizeMCPErrorForLogging(result.reason),
            );
          }
        }
      } catch (error) {
        if (isGovernancePilotEnabled()) throw new Error('Failed to clear MCP OAuth authorization');
        logger.warn(
          `[clearStoredMCPOAuthState] Failed to clear MCP OAuth flow state for ${serverName}:`,
          sanitizeMCPErrorForLogging(error),
        );
      }
    };
    if (!commitTokenDeletion) {
      await clearFlows();
      return;
    }
    await commitTokenDeletion(async (session) => {
      await clearFlows();
      await deleteStoredTokens(session);
    });
  };

  return async (userId, pluginKey, appConfig, commitTokenDeletion) => {
    if (!pluginKey.startsWith(Constants.mcp_prefix)) return;
    const serverName = pluginKey.replace(Constants.mcp_prefix, '');
    const registry = deps.getRegistry();
    const serverConfig =
      (await registry.getServerConfig(serverName, userId)) ?? appConfig?.mcpServers?.[serverName];
    const binding = serverConfig ? deps.getBinding(serverConfig) : undefined;
    const clear = () => clearStoredState(userId, serverName, commitTokenDeletion, binding);
    const oauthServers = await registry.getOAuthServers(userId);
    if (!oauthServers.has(serverName) || !serverConfig) {
      await clear();
      return { outcome: 'failure', reason: 'client_metadata_unavailable' };
    }
    let clientTokenData: Awaited<ReturnType<typeof MCPTokenStorage.getClientInfoAndMetadata>>;
    try {
      clientTokenData = await deps.storage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: deps.tokenMethods.findToken,
        ...(binding ? { binding } : {}),
      });
    } catch (error) {
      logger.warn(
        `[maybeUninstallOAuthMCP] Unable to load OAuth client metadata for ${serverName}; clearing local MCP OAuth state only.`,
        sanitizeMCPErrorForLogging(error),
      );
      await clear();
      return { outcome: 'failure', reason: 'client_metadata_unavailable' };
    }
    if (!clientTokenData) {
      logger.info(
        `[maybeUninstallOAuthMCP] Missing OAuth client metadata for ${serverName}; clearing local MCP OAuth state only.`,
      );
      await clear();
      return { outcome: 'failure', reason: 'client_metadata_unavailable' };
    }
    const { clientInfo, clientMetadata } = clientTokenData;
    let tokens: Awaited<ReturnType<typeof MCPTokenStorage.getTokensForRevocation>> = null;
    try {
      tokens = await deps.storage.getTokensForRevocation({
        userId,
        serverName,
        findToken: deps.tokenMethods.findToken,
        ...(binding ? { binding } : {}),
      });
    } catch (error) {
      logger.warn(
        `[maybeUninstallOAuthMCP] Unable to load OAuth tokens for ${serverName}; clearing local token state.`,
        sanitizeMCPErrorForLogging(error),
      );
    }
    const storedEndpoint = clientMetadata.revocation_endpoint;
    const storedMethods = clientMetadata.revocation_endpoint_auth_methods_supported;
    const revocationEndpoint =
      serverConfig.oauth?.revocation_endpoint ??
      (typeof storedEndpoint === 'string' ? storedEndpoint : undefined);
    const revocationEndpointAuthMethodsSupported =
      serverConfig.oauth?.revocation_endpoint_auth_methods_supported ??
      (Array.isArray(storedMethods) && storedMethods.every((method) => typeof method === 'string')
        ? storedMethods
        : undefined);
    if (commitTokenDeletion) await clear();
    let provider: MCPProviderRevocation =
      tokens?.access_token || tokens?.refresh_token
        ? { outcome: 'success' }
        : { outcome: 'failure', reason: 'tokens_unavailable' };
    const revoke = async (token: string | undefined, type: 'access' | 'refresh') => {
      if (!token) return;
      try {
        await deps.handler.revokeOAuthToken(
          serverName,
          token,
          type,
          {
            serverUrl: serverConfig.url ?? '',
            clientId: clientInfo.client_id,
            clientSecret: clientInfo.client_secret ?? '',
            revocationEndpoint,
            revocationEndpointAuthMethodsSupported,
          },
          serverConfig.oauth_headers ?? {},
          appConfig?.mcpSettings?.allowedDomains,
          appConfig?.mcpSettings?.allowedAddresses,
        );
      } catch (error) {
        provider = mergeMCPRevocationFailure(provider, error);
        logger.error(
          `[maybeUninstallOAuthMCP] Error revoking OAuth ${type} token for ${serverName}:`,
          sanitizeMCPErrorForLogging(error),
        );
      }
    };
    await revoke(tokens?.access_token, 'access');
    await revoke(tokens?.refresh_token, 'refresh');
    if (!commitTokenDeletion) await clear();
    return provider;
  };
}
