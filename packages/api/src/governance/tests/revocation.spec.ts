import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';

import { createOAuthTestFixture, failAuditWrites, outbox } from './oauth.helper';

let fixture: Awaited<ReturnType<typeof createOAuthTestFixture>>;
let administration: typeof import('../mcp');
let authorization: typeof import('../oauth');
let storage: typeof import('~/mcp/oauth').MCPTokenStorage;
let actor: IUser;
const connectionId = '507f1f77bcf86cd799439011';
const otherConnectionId = '507f1f77bcf86cd799439012';
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

async function revokeAuthorization(
  provider: import('librechat-data-provider').MCPProviderRevocation = { outcome: 'success' },
) {
  const handlers = administration.createGovernanceMCPHandlers({
    getRegistry: () => ({
      getServerConfig: async () => ({
        type: 'sse',
        url: 'https://mcp.example/server',
        dbId: connectionId,
      }),
    }),
    getManager: () => ({ disconnectUserConnection: async () => {} }),
    discover: async () => ({ tools: [], oauthRequired: false, oauthUrl: null }),
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
      return provider;
    },
  });
  const app = express();
  app.use((req, _res, next) => {
    (req as ServerRequest).user = actor;
    next();
  });
  app.post('/:serverName/revoke', handlers.revoke);
  return request(app).post(`/${serverName}/revoke`);
}

it('rejects a callback whose token exchange finishes after successful revocation', async () => {
  await fixture.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const revoked = await revokeAuthorization();
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({
      success: true,
      local_disconnection: { outcome: 'success' },
      provider_revocation: { outcome: 'success' },
    });
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(false);

    await expect(
      administration.storeGovernanceMCPOAuth(
        { user: actor } as ServerRequest,
        connectionId,
        tokenData(),
        generation,
      ),
    ).rejects.toThrow();

    expect(await fixture.models.Token.countDocuments()).toBe(0);
    const events = await outbox().find().toArray();
    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({
      action: 'mcp.oauth.disconnected_locally',
      outcome: 'success',
    });
  });
});

it('allows a fresh authorization started after revocation', async () => {
  await fixture.runAsSystem(async () => {
    const previous = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    expect((await revokeAuthorization()).status).toBe(200);
    const current = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    expect(current).toBeGreaterThan(previous);

    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      current,
    );

    expect(await fixture.models.Token.countDocuments()).toBe(3);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(true);
    expect(
      await storage.getTokens({
        userId: actor.id,
        serverName,
        findToken: fixture.methods.findToken,
      }),
    ).toMatchObject({ access_token: 'access-secret', refresh_token: 'refresh-secret' });
    const events = await outbox().find().sort({ createdAt: 1 }).toArray();
    expect(events.map(({ payload }) => payload.action)).toEqual([
      'mcp.oauth.disconnected_locally',
      'mcp.oauth.provider_revocation',
      'mcp.oauth.authorized',
    ]);
  });
});

it('reports authorization only for the connection configuration that received the grant', async () => {
  await fixture.runAsSystem(async () => {
    const binding = 'a'.repeat(64);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      { ...tokenData(), binding },
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    );
    expect(
      await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId, binding),
    ).toBe(true);
    expect(
      await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId, 'b'.repeat(64)),
    ).toBe(false);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(false);
  });
});

it('rejects an authorization transaction with a snapshot from before revocation committed', async () => {
  await fixture.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await fixture.models.Token.countDocuments().session(session);
      expect((await revokeAuthorization()).status).toBe(200);
      await expect(
        authorization.claimGovernanceMCPOAuthGeneration(
          actor.id,
          connectionId,
          generation,
          session,
        ),
      ).rejects.toThrow();
    } finally {
      await session.abortTransaction();
      await session.endSession();
    }
    expect(await fixture.models.Token.countDocuments()).toBe(0);
    expect(
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    ).toBeGreaterThan(generation);
  });
});

it('rolls back the revocation generation and token deletion when audit insertion fails', async () => {
  await fixture.runAsSystem(async () => {
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId),
    );
    await outbox().deleteMany({});
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const tokens = await fixture.models.Token.find().sort({ identifier: 1 }).lean();
    const failure = failAuditWrites();
    const revoked = await revokeAuthorization();
    failure.mockRestore();

    expect(revoked.status).toBe(500);
    expect(await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId)).toBe(
      generation,
    );
    expect(await fixture.models.Token.find().sort({ identifier: 1 }).lean()).toEqual(tokens);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(true);
    expect(await outbox().countDocuments()).toBe(0);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    expect(await fixture.models.Token.countDocuments()).toBe(3);
  });
});

it('rolls back the authorization generation when storing its audit fails', async () => {
  await fixture.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    const failure = failAuditWrites();
    await expect(
      administration.storeGovernanceMCPOAuth(
        { user: actor } as ServerRequest,
        connectionId,
        tokenData(),
        generation,
      ),
    ).rejects.toThrow('audit unavailable');
    failure.mockRestore();

    expect(await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId)).toBe(
      generation,
    );
    expect(await fixture.models.Token.countDocuments()).toBe(0);
    expect(await outbox().countDocuments()).toBe(0);
    expect(await authorization.isGovernanceMCPOAuthAuthorized(actor.id, connectionId)).toBe(false);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    expect(await fixture.models.Token.countDocuments()).toBe(3);
  });
});

it('isolates revocation generations by administrator, connection, and tenant', async () => {
  const otherUserId = new mongoose.Types.ObjectId().toString();
  const scopes = [
    { tenantId: 'first', userId: actor.id, connectionId },
    { tenantId: 'first', userId: otherUserId, connectionId },
    { tenantId: 'first', userId: actor.id, connectionId: otherConnectionId },
    { tenantId: 'second', userId: actor.id, connectionId },
  ];
  const generations = await Promise.all(
    scopes.map((scope) =>
      fixture.tenantStorage.run({ tenantId: scope.tenantId }, async () =>
        authorization.getGovernanceMCPOAuthGeneration(scope.userId, scope.connectionId),
      ),
    ),
  );
  const first = scopes[0];
  await fixture.tenantStorage.run({ tenantId: first.tenantId }, async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () =>
        authorization.claimGovernanceMCPOAuthGeneration(
          first.userId,
          first.connectionId,
          generations[0],
          session,
        ),
      );
    } finally {
      await session.endSession();
    }
  });
  const updated = await Promise.all(
    scopes.map((scope) =>
      fixture.tenantStorage.run({ tenantId: scope.tenantId }, async () =>
        authorization.getGovernanceMCPOAuthGeneration(scope.userId, scope.connectionId),
      ),
    ),
  );
  expect(updated[0]).toBeGreaterThan(generations[0]);
  expect(updated.slice(1)).toEqual(generations.slice(1));
});

it('does not publish or reconnect a committed grant after revocation wins the next transaction', async () => {
  await fixture.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    expect((await revokeAuthorization()).status).toBe(200);
    const publish = jest.fn(async () => {});

    await expect(
      authorization.withGovernanceMCPOAuthGeneration(
        actor.id,
        connectionId,
        generation + 1,
        publish,
      ),
    ).rejects.toThrow('MCP OAuth authorization is no longer current');

    expect(publish).not.toHaveBeenCalled();
    expect(await fixture.models.Token.countDocuments()).toBe(0);
  });
});

it('serializes revocation behind an authorization publication already in progress', async () => {
  await fixture.runAsSystem(async () => {
    const generation = await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId);
    await administration.storeGovernanceMCPOAuth(
      { user: actor } as ServerRequest,
      connectionId,
      tokenData(),
      generation,
    );
    let releasePublication: () => void = () => {};
    let publicationStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishing = authorization.withGovernanceMCPOAuthGeneration(
      actor.id,
      connectionId,
      generation + 1,
      async () => {
        publicationStarted();
        await released;
      },
    );
    await started;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await expect(
        authorization.advanceGovernanceMCPOAuthGeneration(actor.id, connectionId, session),
      ).rejects.toThrow();
    } finally {
      await session.abortTransaction();
      await session.endSession();
      releasePublication();
      await publishing;
    }

    expect((await revokeAuthorization()).status).toBe(200);
    expect(await fixture.models.Token.countDocuments()).toBe(0);
    expect(await authorization.getGovernanceMCPOAuthGeneration(actor.id, connectionId)).toBe(
      generation + 2,
    );
  });
});

it('keeps local deletion successful and audits a provider 503 separately', async () => {
  await fixture.runAsSystem(async () => {
    await storage.storeTokens(tokenData());
    const provider = {
      outcome: 'failure' as const,
      reason: 'provider_unavailable' as const,
      http_status: 503,
    };
    const response = await revokeAuthorization(provider);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: false,
      local_disconnection: { outcome: 'success' },
      provider_revocation: provider,
    });
    expect(await fixture.models.Token.countDocuments()).toBe(0);
    const events = await outbox().find().sort({ createdAt: 1 }).toArray();
    expect(
      events.map(({ payload }) => ({
        action: payload.action,
        outcome: payload.outcome,
        reason: payload.reason,
        http_status: payload.http_status,
      })),
    ).toEqual([
      { action: 'mcp.oauth.disconnected_locally', outcome: 'success' },
      { action: 'mcp.oauth.provider_revocation', ...provider },
    ]);
    expect(JSON.stringify(events)).not.toContain('access-secret');
  });
});
