import express from 'express';
import request from 'supertest';
import { Keyv } from 'keyv';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';

import { createOAuthTestFixture, failAuditWrites, outbox } from './oauth.helper';

let fixture: Awaited<ReturnType<typeof createOAuthTestFixture>>;
let administration: typeof import('../mcp');
let authorization: typeof import('../oauth');
let storage: typeof import('~/mcp/oauth').MCPTokenStorage;
let actor: IUser;
const connectionId = '507f1f77bcf86cd799439011';
const serverName = 'administrative';
const tokenData = () => ({
  userId: actor.id,
  serverName,
  tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer' },
  clientInfo: { client_id: 'client', client_secret: 'client-secret' },
  createToken: fixture.methods.createToken,
  updateToken: fixture.methods.updateToken,
  findToken: fixture.methods.findToken,
});

beforeAll(async () => {
  fixture = await createOAuthTestFixture();
  administration = await import('../mcp');
  authorization = await import('../oauth');
  storage = (await import('~/mcp/oauth')).MCPTokenStorage;
}, 60000);

afterAll(async () => {
  await fixture?.close();
});

beforeEach(async () => {
  actor = await fixture.reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it.each([false, true])(
  'completes the typed callback atomically; audit failure: %s',
  async (failAudit) => {
    const { createGovernanceMCPOAuthCompletion } = await import('../callback');
    const { getGovernanceMCPOAuthBinding } = await import('../authorization');
    const { MCPOAuthHandler } = await import('~/mcp/oauth');
    const { FlowStateManager } = await import('~/flow/manager');
    const config = { type: 'sse' as const, url: 'https://mcp.example/server', dbId: connectionId };
    const binding = getGovernanceMCPOAuthBinding(config)!;
    const flowId = MCPOAuthHandler.generateFlowId(actor.id, serverName, undefined, binding);
    const flowManager = new FlowStateManager<import('~/mcp/oauth').MCPOAuthTokens | null>(
      new Keyv(),
      { ttl: 60000, ci: true },
    );
    const flowState = {
      userId: actor.id,
      serverName,
      serverUrl: config.url,
      binding,
      state: 'callback-state',
      clientInfo: { client_id: 'client', client_secret: 'client-secret' },
    };
    await flowManager.initFlow(flowId, 'mcp_oauth', flowState);
    const complete = createGovernanceMCPOAuthCompletion({
      findUser: fixture.methods.findUser,
      getServerConfig: async () => config,
      tokenMethods: fixture.methods,
      handler: {
        completeOAuthFlow: async () => ({ ...tokenData().tokens, obtained_at: Date.now() }),
        buildStoredClientMetadata: MCPOAuthHandler.buildStoredClientMetadata,
        generateTokenFlowId: MCPOAuthHandler.generateTokenFlowId.bind(MCPOAuthHandler),
      },
      getGeneration: authorization.getGovernanceMCPOAuthGeneration,
      storeAuthorization: administration.storeGovernanceMCPOAuth,
      withGeneration: authorization.withGovernanceMCPOAuthGeneration,
    });
    const app = express();
    app.get('/:serverName', (req, res) =>
      complete(req, res, {
        flowId,
        code: 'authorization-code',
        state: flowState.state,
        flowState,
        flowManager,
        parsedFlowId: MCPOAuthHandler.parseFlowId(flowId)!,
      }),
    );
    await fixture.runAsSystem(async () => {
      const failure = failAudit ? failAuditWrites() : undefined;
      const response = await request(app).get(`/${serverName}`);
      failure?.mockRestore();
      expect(response.status).toBe(302);
      expect(response.headers.location).toContain(failAudit ? '/oauth/error' : '/oauth/success');
      expect(await fixture.models.Token.countDocuments()).toBe(failAudit ? 0 : 3);
      const flow = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(flow?.status).toBe(failAudit ? 'FAILED' : 'COMPLETED');
      if (!failAudit) {
        expect(flow?.result).toBeNull();
        expect((await outbox().findOne())?.payload).toMatchObject({
          action: 'mcp.oauth.authorized',
          outcome: 'success',
          resource: { id: connectionId },
        });
        expect(
          await storage.getTokens({
            userId: actor.id,
            serverName,
            binding,
            findToken: fixture.methods.findToken,
          }),
        ).toMatchObject(tokenData().tokens);
      }
      expect(response.text).not.toContain('access-secret');
      expect(JSON.stringify(await fixture.models.Token.find().lean())).not.toContain(
        'access-secret',
      );
    });
  },
);

it('commits encrypted access, refresh, and client tokens with the authorization event', async () => {
  await fixture.runAsSystem(async () => {
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    );
    expect(await fixture.models.Token.countDocuments()).toBe(3);
    expect((await outbox().findOne())?.payload).toMatchObject({
      action: 'mcp.oauth.authorized',
      outcome: 'success',
      resource: { id: connectionId },
    });
    const persisted = JSON.stringify(await fixture.models.Token.find().lean());
    for (const secret of ['access-secret', 'refresh-secret', 'client-secret']) {
      expect(persisted).not.toContain(secret);
      expect(JSON.stringify(await outbox().findOne())).not.toContain(secret);
    }
    expect(
      await storage.getTokens({
        userId: actor.id,
        serverName,
        findToken: fixture.methods.findToken,
      }),
    ).toMatchObject({ access_token: 'access-secret', refresh_token: 'refresh-secret' });
  });
});

it('rolls back token replacements when durable authorization audit insertion fails', async () => {
  await fixture.runAsSystem(async () => {
    await storage.storeTokens(tokenData());
    const before = await fixture.models.Token.find().sort({ identifier: 1 }).lean();
    const failure = failAuditWrites();
    const replacement = {
      ...tokenData(),
      tokens: {
        access_token: 'replacement',
        refresh_token: 'replacement-refresh',
        token_type: 'Bearer',
      },
    };
    await expect(
      administration.storeGovernanceMCPOAuth(
        { user: actor } as ServerRequest,
        connectionId,
        replacement,
        await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
      ),
    ).rejects.toThrow('audit unavailable');
    failure.mockRestore();
    expect(await fixture.models.Token.find().sort({ identifier: 1 }).lean()).toEqual(before);
    expect(await outbox().countDocuments()).toBe(0);
  });
});

it('rolls back earlier token writes when a later token write fails', async () => {
  await fixture.runAsSystem(async () => {
    await expect(
      administration.storeGovernanceMCPOAuth(
        { user: actor } as ServerRequest,
        connectionId,
        {
          ...tokenData(),
          createToken: (token, session) => {
            if (token.type === 'mcp_oauth_refresh') throw new Error('refresh persistence failed');
            return fixture.methods.createToken(token, session);
          },
        },
        await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
      ),
    ).rejects.toThrow('refresh persistence failed');
    expect(await fixture.models.Token.countDocuments()).toBe(0);
    expect(await outbox().countDocuments()).toBe(0);
  });
});

it.each([false, true])(
  'revocation deletes tokens and audit together; outbox failure: %s',
  async (failAudit) => {
    await fixture.runAsSystem(async () => {
      await storage.storeTokens(tokenData());
      const before = await fixture.models.Token.find().sort({ identifier: 1 }).lean();
      const providerRevoke = jest.fn();
      const disconnect = jest.fn().mockResolvedValue(undefined);
      const handlers = administration.createGovernanceMCPHandlers({
        getRegistry: () => ({
          getServerConfig: jest.fn().mockResolvedValue({ dbId: connectionId }),
        }),
        getManager: () => ({ disconnectUserConnection: disconnect }),
        discover: jest.fn(),
        revoke: async (userId, _plugin, _config, commit) => {
          if (!commit) throw new Error('Governed deletion must supply a transaction');
          await commit(async (session) =>
            storage.deleteUserTokens({
              userId,
              serverName,
              deleteToken: async (filter) => {
                await fixture.methods.deleteTokens(filter, session);
              },
            }),
          );
          providerRevoke();
        },
      });
      const app = express();
      app.use((req, _res, next) => {
        (req as ServerRequest).user = actor;
        next();
      });
      app.post('/:serverName/revoke', handlers.revoke);
      const failure = failAudit ? failAuditWrites() : undefined;
      const response = await request(app).post(`/${serverName}/revoke`);
      failure?.mockRestore();
      expect(response.status).toBe(failAudit ? 500 : 200);
      expect(disconnect).toHaveBeenCalledWith(actor.id, serverName);
      if (failAudit) {
        expect(await fixture.models.Token.find().sort({ identifier: 1 }).lean()).toEqual(before);
        expect(await outbox().countDocuments()).toBe(0);
        expect(providerRevoke).not.toHaveBeenCalled();
      } else {
        expect(await fixture.models.Token.countDocuments()).toBe(0);
        expect((await outbox().findOne())?.payload).toMatchObject({
          action: 'mcp.oauth.disconnected_locally',
          outcome: 'success',
        });
        expect(providerRevoke).toHaveBeenCalledTimes(1);
      }
    });
  },
);
