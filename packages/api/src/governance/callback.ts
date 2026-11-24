import { getTenantId, tenantStorage, logger } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import type { AllMethods, IUser, TokenMethods } from '@librechat/data-schemas';
import type { MCPOAuthFlowMetadata, MCPOAuthTokens } from '~/mcp/oauth';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import type { ParsedServerConfig } from '~/mcp/types';
import type { FlowStateManager } from '~/flow/manager';
import type { ServerRequest } from '~/types/http';
import type { Request, Response } from 'express';
import { isGovernanceMCPAuditConfigured, recordGovernanceMCPFailure } from './audit';
import { getGovernanceMCPOAuthBinding } from './authorization';
import type { storeGovernanceMCPOAuth } from './mcp';
import type { getGovernanceMCPOAuthGeneration, withGovernanceMCPOAuthGeneration } from './oauth';
import { GovernanceMCPOAuthStaleError } from './oauth';
import { MCPOAuthHandler } from '~/mcp/oauth';
import { getBasePath } from '~/utils/path';
import { isGovernancePilotEnabled } from './mode';

export async function getMCPAuthorizationFlowId(
  userId: string,
  serverName: string,
  getServerConfig: MCPServersRegistry['getServerConfig'],
  handler: Pick<typeof MCPOAuthHandler, 'generateFlowId'> = MCPOAuthHandler,
): Promise<string> {
  let binding: string | undefined;
  if (isGovernancePilotEnabled()) {
    const config = await getServerConfig(serverName, userId);
    binding = getGovernanceMCPOAuthBinding(config);
    if (!binding) throw new Error('MCP connection not found');
  }
  return handler.generateFlowId(userId, serverName, getTenantId(), ...(binding ? [binding] : []));
}

export async function getMCPAuthorizationInitiationBinding(
  userId: string,
  serverName: string,
  capturedBinding: string | undefined,
  getServerConfig: MCPServersRegistry['getServerConfig'],
): Promise<string | false | undefined> {
  if (!isGovernancePilotEnabled()) return;
  const binding = getGovernanceMCPOAuthBinding(await getServerConfig(serverName, userId));
  return binding && capturedBinding === binding ? binding : false;
}

interface GovernanceMCPOAuthCompletionDependencies {
  findUser: AllMethods['findUser'];
  getServerConfig: MCPServersRegistry['getServerConfig'];
  tokenMethods: Pick<TokenMethods, 'createToken' | 'updateToken' | 'findToken'>;
  handler: Pick<
    typeof MCPOAuthHandler,
    'completeOAuthFlow' | 'buildStoredClientMetadata' | 'generateTokenFlowId'
  >;
  getGeneration: typeof getGovernanceMCPOAuthGeneration;
  storeAuthorization: typeof storeGovernanceMCPOAuth;
  withGeneration: typeof withGovernanceMCPOAuthGeneration;
}

interface GovernanceMCPOAuthCompletion {
  flowId: string;
  code: string;
  state: string;
  parsedFlowId: NonNullable<ReturnType<typeof MCPOAuthHandler.parseFlowId>>;
  flowState: MCPOAuthFlowMetadata;
  flowManager: FlowStateManager<MCPOAuthTokens | null>;
}

export function createGovernanceMCPOAuthCompletion(
  deps: GovernanceMCPOAuthCompletionDependencies,
): (
  req: Request<{ serverName: string }>,
  res: Response,
  completion: GovernanceMCPOAuthCompletion,
) => Promise<void> {
  return async (req, res, { flowId, code, state, parsedFlowId, flowState, flowManager }) => {
    const { serverName } = req.params;
    const basePath = getBasePath();
    const successUrl = `${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`;
    const complete = async () => {
      let administrator: IUser | null = null;
      let config: ParsedServerConfig | undefined;
      let committed = false;
      try {
        administrator = await deps.findUser({ _id: flowState.userId });
        config = await deps.getServerConfig(serverName, flowState.userId);
        if (
          administrator?.provider !== 'openid' ||
          administrator.role !== SystemRoles.GOVERNANCE_ADMIN ||
          flowState.userId === 'system' ||
          flowState.serverName !== serverName ||
          !config?.dbId ||
          !flowState.binding ||
          parsedFlowId.binding !== flowState.binding ||
          getGovernanceMCPOAuthBinding(config) !== flowState.binding ||
          !isGovernanceMCPAuditConfigured({ user: administrator } as ServerRequest)
        ) {
          throw new Error('OIDC administrator entitlement required');
        }
        const generation = await deps.getGeneration(flowState.userId, config.dbId);
        const pendingFlow = await flowManager.getFlowState(flowId, 'mcp_oauth');
        if (
          pendingFlow?.status !== 'PENDING' ||
          pendingFlow.metadata?.state !== state ||
          pendingFlow.metadata?.binding !== flowState.binding
        ) {
          throw new GovernanceMCPOAuthStaleError();
        }
        const tokens = await deps.handler.completeOAuthFlow(
          flowId,
          code,
          flowManager,
          flowState.oauthHeaders ?? config.oauth_headers ?? {},
          false,
        );
        if (!tokens) throw new Error('OAuth authorization returned no tokens');
        await deps.storeAuthorization(
          { user: administrator } as ServerRequest,
          config.dbId,
          {
            userId: flowState.userId,
            serverName,
            tokens,
            ...deps.tokenMethods,
            clientInfo: flowState.clientInfo,
            metadata: deps.handler.buildStoredClientMetadata(
              flowState.metadata,
              flowState.resourceMetadata,
            ),
            binding: flowState.binding,
          },
          generation,
        );
        committed = true;
        await deps.withGeneration(flowState.userId, config.dbId, generation + 1, async () => {
          try {
            await flowManager.completeFlow(flowId, 'mcp_oauth', null);
          } catch {
            logger.warn('[MCP OAuth] Committed authorization flow could not be published');
          }
          const tokenFlowId = deps.handler.generateTokenFlowId(
            flowState.userId,
            serverName,
            flowState.tenantId,
            flowState.binding,
          );
          await flowManager.deleteFlow(tokenFlowId, 'mcp_get_tokens');
          if (tokenFlowId !== flowId) await flowManager.deleteFlow(flowId, 'mcp_get_tokens');
        });
        res.redirect(successUrl);
      } catch (error) {
        if (committed) {
          logger.warn('[MCP OAuth] Committed authorization cache update remains pending');
          res.redirect(successUrl);
          return;
        }
        if (administrator) {
          await recordGovernanceMCPFailure(
            { user: administrator } as ServerRequest,
            'mcp.oauth.authorized',
            config?.dbId,
          );
          try {
            if (!(error instanceof GovernanceMCPOAuthStaleError))
              await flowManager.failFlow(flowId, 'mcp_oauth', 'OAuth authorization failed');
          } catch {
            logger.warn('[MCP OAuth] Failed authorization flow could not be cleared');
          }
        }
        logger.error('[MCP OAuth] OAuth callback error', 'MCP operation failed');
        res.redirect(`${basePath}/oauth/error?error=callback_failed`);
      }
    };
    if (flowState.tenantId && !getTenantId()) {
      await tenantStorage.run({ tenantId: flowState.tenantId }, complete);
      return;
    }
    await complete();
  };
}
