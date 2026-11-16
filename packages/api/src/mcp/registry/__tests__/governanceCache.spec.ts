import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { GovernanceMCPMutation } from '~/governance/audit';
import type { ParsedServerConfig } from '~/mcp/types';
import { MCPServerInspector } from '../MCPServerInspector';
import { MCPServersRegistry } from '../MCPServersRegistry';

jest.mock('../MCPServerInspector');
jest.mock('../db/ServerConfigsDB', () => ({
  ServerConfigsDB: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    getAll: jest.fn().mockResolvedValue({}),
    add: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  })),
}));

const config: ParsedServerConfig = {
  type: 'sse',
  url: 'https://remote.example/mcp',
  title: 'Remote',
  dbId: '0123456789abcdef01234567',
};
const operations = ['create', 'update', 'delete'] as const;
type Operation = (typeof operations)[number];

let registry: MCPServersRegistry;

function applyMutation(operation: Operation, mutation?: GovernanceMCPMutation) {
  if (operation === 'create') {
    return registry.addServer('remote', config, 'DB', 'administrator', [], mutation);
  }
  if (operation === 'update') {
    return registry.updateServer('remote', config, 'DB', 'administrator', mutation);
  }
  return registry.removeServer('remote', 'DB', 'administrator', mutation);
}

beforeEach(() => {
  registry = new MCPServersRegistry(mongoose);
  jest.spyOn(MCPServerInspector, 'inspect').mockResolvedValue(config);
  jest.spyOn(registry['dbConfigsRepo'], 'get').mockResolvedValue(config);
  jest.spyOn(registry['dbConfigsRepo'], 'add').mockResolvedValue({
    serverName: 'remote',
    config,
  });
  jest.spyOn(logger, 'warn').mockReturnValue(logger);
});

it.each(operations)(
  'keeps a committed %s successful when cache invalidation fails',
  async (operation) => {
    let committed = false;
    const mutation: GovernanceMCPMutation = async (persist, connectionId) => {
      const result = await persist();
      expect(typeof connectionId === 'function' ? connectionId(result) : connectionId).toBe(
        config.dbId,
      );
      committed = true;
      return result;
    };
    const invalidate = jest
      .spyOn(registry['readThroughCache'], 'delete')
      .mockImplementation(async () => {
        expect(committed).toBe(true);
        throw new Error('private cache failure');
      });

    await applyMutation(operation, mutation);

    expect(invalidate).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[Governance MCP] Committed connection cache invalidation failed',
    );
    expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain(
      'private cache failure',
    );
  },
);

it.each(operations)(
  'does not invalidate caches when a %s transaction aborts',
  async (operation) => {
    const mutation: GovernanceMCPMutation = async (persist) => {
      await persist();
      throw new Error('audit insertion failed');
    };
    const invalidate = jest.spyOn(registry['readThroughCache'], 'delete');

    await expect(applyMutation(operation, mutation)).rejects.toThrow('audit insertion failed');

    expect(invalidate).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  },
);

it.each(operations)(
  'preserves existing %s cache error behavior without governed mutation',
  async (operation) => {
    jest.spyOn(registry['readThroughCache'], 'delete').mockRejectedValue(new Error('cache failed'));

    await expect(applyMutation(operation)).rejects.toThrow('cache failed');

    expect(logger.warn).not.toHaveBeenCalled();
  },
);
