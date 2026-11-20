import http from 'node:http';
import { inspect } from 'node:util';
import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '~/mcp/types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { ConnectionsRepository } from '~/mcp/ConnectionsRepository';
import { trackSockets } from './helpers/oauthTestServer';
import { MCPConnection } from '~/mcp/connection';
import { MCPManager } from '~/mcp/MCPManager';

class TrackedManager extends MCPManager {
  remember(userId: string, serverName: string, connection: MCPConnection): void {
    this.userConnections.set(userId, new Map([[serverName, connection]]));
  }
}

class TrackedRepository extends ConnectionsRepository {
  remember(serverName: string, connection: MCPConnection): void {
    this.connections.set(serverName, connection);
  }
}

const environment = process.env;
const secret = 'administrator-service-credential';
const administrator = { id: 'administrator', role: 'GOVERNANCE_ADMIN' } as IUser;

function captureLogs() {
  return (['debug', 'info', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(logger, level).mockImplementation(() => logger),
  );
}

afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

it.each([true, false])(
  'protects provider-echoed credentials while preserving connection failures; governed: %s',
  async (governed) => {
    process.env = { ...environment, GOVERNANCE_PILOT_ENABLED: String(governed) };
    const logs = captureLogs();
    const authorization: (string | undefined)[] = [];
    const remote = http.createServer((req, res) => {
      authorization.push(req.headers.authorization);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`Rejected service credential ${req.headers.authorization}`);
    });
    const close = trackSockets(remote);
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('MCP fixture has no TCP port');
    const serverName = `credential-failure-${governed}`;
    const config: ParsedServerConfig = {
      type: 'streamable-http',
      source: 'user',
      dbId: '507f1f77bcf86cd799439011',
      url: `http://127.0.0.1:${address.port}/mcp`,
      requiresOAuth: false,
      apiKey: { source: 'admin', authorization_type: 'bearer', key: secret },
      initTimeout: 15000,
    };
    const registry = new MCPServersRegistry(mongoose);
    jest
      .spyOn(registry, 'getServerConfig')
      .mockImplementation(async (_name, userId) => (userId ? config : undefined));
    jest.spyOn(registry, 'resolveAllowlists').mockResolvedValue({
      allowedDomains: ['127.0.0.1'],
      allowedAddresses: ['127.0.0.1'],
      useSSRFProtection: false,
    });
    jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue(registry);
    const create = jest.spyOn(MCPConnectionFactory, 'create');
    const manager = new MCPManager();
    manager.appConnections = new ConnectionsRepository();
    try {
      const failure = manager.getUserConnection({
        user: administrator,
        serverName,
        serverConfig: config,
      });
      await expect(failure).rejects.toThrow(`Rejected service credential Bearer ${secret}`);
      const original = await create.mock.results[0].value.catch((error: Error) => error);
      await expect(failure).rejects.toBe(original);
      expect(authorization).toEqual(Array(3).fill(`Bearer ${secret}`));
      expect(manager.getUserConnections(administrator.id)).toBeUndefined();
      const logged = logs
        .flatMap((log) => log.mock.calls)
        .map((args) => inspect(args))
        .join('\n');
      if (governed) {
        expect(logged).not.toContain(secret);
        expect(logger.error).toHaveBeenCalledWith(
          `[MCP][User: ${administrator.id}][${serverName}] Failed to establish connection`,
          'MCP connection operation failed',
        );
      } else {
        expect(logged).toContain(secret);
        expect(logger.error).toHaveBeenCalledWith(
          `[MCP][User: ${administrator.id}][${serverName}] Failed to establish connection`,
          original,
        );
      }
    } finally {
      await close();
      MCPConnection.clearCooldown(serverName);
    }
  },
  30000,
);

it.each([true, false])(
  'protects connection cleanup errors without changing cleanup outcomes; governed: %s',
  async (governed) => {
    process.env = { ...environment, GOVERNANCE_PILOT_ENABLED: String(governed) };
    const logs = captureLogs();
    const serverName = 'credential-cleanup';
    const connection = new MCPConnection({
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://mcp.example/server' },
    });
    const failure = new Error(`Provider cleanup failed with credential ${secret}`);
    const disconnect = jest.spyOn(connection, 'disconnect').mockRejectedValue(failure);
    const repository = new TrackedRepository();
    repository.remember(serverName, connection);
    const manager = new TrackedManager();
    manager.remember(administrator.id, serverName, connection);

    await expect(repository.disconnect(serverName)).resolves.toBeUndefined();
    await expect(manager.disconnectUserConnections(administrator.id)).resolves.toBeUndefined();

    expect(repository.getConnectionCount()).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(2);
    const logged = logs
      .flatMap((log) => log.mock.calls)
      .map((args) => inspect(args))
      .join('\n');
    if (governed) expect(logged).not.toContain(secret);
    else expect(logged).toContain(secret);
    for (const message of [
      `[MCP][${serverName}] Error disconnecting`,
      `[MCP][User: ${administrator.id}][${serverName}] Error during disconnection:`,
    ]) {
      expect(logger.error).toHaveBeenCalledWith(
        message,
        governed ? 'MCP connection operation failed' : failure,
      );
    }
  },
);
