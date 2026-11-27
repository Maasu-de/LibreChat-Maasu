import { logger } from '@librechat/data-schemas';
import { MCPServerUserInputSchema } from 'librechat-data-provider';
import type { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import type { RequestHandler, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createGovernanceMCPMutation, recordGovernanceMCPFailure } from './audit';
import { isGovernanceRemoteMCP, rejectGovernanceMCPUpdate } from './mcp';
import {
  isMCPDomainNotAllowedError,
  isMCPInspectionFailedError,
  MCPApiKeyReentryRequiredError,
  MCPOAuthSecretReentryRequiredError,
} from '~/mcp/errors';
import { redactServerSecrets } from '~/mcp/utils';

interface GovernanceMCPServerDependencies {
  getRegistry: () => Pick<
    MCPServersRegistry,
    'getServerConfig' | 'addServer' | 'updateServer' | 'removeServer'
  >;
  resolveReservedNames: (req: ServerRequest) => Promise<Iterable<string>>;
}

const customIconError = {
  error: 'MCP_CUSTOM_ICON_NOT_ALLOWED',
  message: 'Custom icons are not supported for governed MCP connections',
};

function sendMutationError(res: Response, error: Error & { statusCode?: number }): void {
  if (
    error instanceof MCPApiKeyReentryRequiredError ||
    error instanceof MCPOAuthSecretReentryRequiredError
  ) {
    res.status(400).json({ error: error.code, message: error.message });
    return;
  }
  if (isMCPDomainNotAllowedError(error)) {
    res.status(error.statusCode).json({
      error: error.code,
      message: 'The MCP server domain is not allowed',
    });
    return;
  }
  if (isMCPInspectionFailedError(error)) {
    res.status(error.statusCode).json({
      error: error.code,
      message: 'Could not connect to the MCP server',
    });
    return;
  }
  res.status(error.statusCode ?? 400).json({ message: 'MCP connection operation failed' });
}

export function createGovernanceMCPServerHandlers(deps: GovernanceMCPServerDependencies): {
  create: RequestHandler;
  update: RequestHandler<{ serverName: string }>;
  delete: RequestHandler<{ serverName: string }>;
} {
  const create: RequestHandler = async (req, res) => {
    const request = req as ServerRequest;
    let committed = false;
    try {
      const validation = MCPServerUserInputSchema.safeParse(req.body.config);
      if (!validation.success) {
        await recordGovernanceMCPFailure(request, 'mcp.created');
        res.status(400).json({ message: 'Invalid configuration', errors: validation.error.errors });
        return;
      }
      if (!isGovernanceRemoteMCP(validation.data)) {
        await recordGovernanceMCPFailure(request, 'mcp.created');
        res.status(400).json({
          error: 'MCP_INVALID_ADMIN_CONNECTION',
          message: 'Only remote administrative MCP connections are supported',
        });
        return;
      }
      if (validation.data.iconPath) {
        await recordGovernanceMCPFailure(request, 'mcp.created');
        res.status(400).json(customIconError);
        return;
      }
      const result = await deps
        .getRegistry()
        .addServer(
          'temp_server_name',
          validation.data,
          'DB',
          request.user?.id,
          await deps.resolveReservedNames(request),
          createGovernanceMCPMutation(request, 'mcp.created'),
        );
      committed = true;
      res.status(201).json({
        serverName: result.serverName,
        ...redactServerSecrets(result.config, { canEdit: true }),
      });
    } catch (error) {
      if (!committed) await recordGovernanceMCPFailure(request, 'mcp.created');
      logger.error('[createMCPServer]', 'MCP operation failed');
      sendMutationError(res, error instanceof Error ? error : new Error());
    }
  };
  const update: RequestHandler<{ serverName: string }> = async (req, res) => {
    const request = req as ServerRequest;
    const { serverName } = req.params;
    let connectionId: string | undefined;
    let committed = false;
    try {
      const existing = await deps.getRegistry().getServerConfig(serverName, request.user?.id);
      connectionId = existing?.dbId;
      const validation = MCPServerUserInputSchema.safeParse(req.body.config);
      if (!validation.success) {
        await rejectGovernanceMCPUpdate(
          request,
          res,
          { message: 'Invalid configuration', errors: validation.error.errors },
          connectionId,
        );
        return;
      }
      if (!isGovernanceRemoteMCP(validation.data)) {
        await rejectGovernanceMCPUpdate(
          request,
          res,
          {
            error: 'MCP_INVALID_ADMIN_CONNECTION',
            message: 'Only remote administrative MCP connections are supported',
          },
          connectionId,
        );
        return;
      }
      if (validation.data.iconPath) {
        await rejectGovernanceMCPUpdate(request, res, customIconError, connectionId);
        return;
      }
      const config = await deps
        .getRegistry()
        .updateServer(
          serverName,
          validation.data,
          'DB',
          request.user?.id,
          createGovernanceMCPMutation(request, 'mcp.updated'),
        );
      committed = true;
      res.status(200).json(redactServerSecrets(config, { canEdit: true }));
    } catch (error) {
      if (!committed) await recordGovernanceMCPFailure(request, 'mcp.updated', connectionId);
      logger.error('[updateMCPServer]', 'MCP operation failed');
      sendMutationError(res, error instanceof Error ? error : new Error());
    }
  };
  const remove: RequestHandler<{ serverName: string }> = async (req, res) => {
    const request = req as ServerRequest;
    const { serverName } = req.params;
    let connectionId: string | undefined;
    let committed = false;
    try {
      const existing = await deps.getRegistry().getServerConfig(serverName, request.user?.id);
      connectionId = existing?.dbId;
      await deps
        .getRegistry()
        .removeServer(
          serverName,
          'DB',
          request.user?.id,
          createGovernanceMCPMutation(request, 'mcp.deleted'),
        );
      committed = true;
      res.status(200).json({ message: 'MCP server deleted successfully' });
    } catch {
      if (!committed) await recordGovernanceMCPFailure(request, 'mcp.deleted', connectionId);
      logger.error('[deleteMCPServer]', 'MCP operation failed');
      res.status(500).json({ message: 'MCP connection operation failed' });
    }
  };
  return { create, update, delete: remove };
}
