import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;
let storage: typeof import('./tokens').MCPTokenStorage;
let methods: ReturnType<typeof import('@librechat/data-schemas').createMethods>;
let models: ReturnType<typeof import('@librechat/data-schemas').createModels>;
const userId = new mongoose.Types.ObjectId().toString();
const otherUserId = new mongoose.Types.ObjectId().toString();
const serverName = 'managed-remote';
const current = 'current-connection';
const previous = 'previous-connection';

beforeAll(async () => {
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';
  const schemas = await import('@librechat/data-schemas');
  models = schemas.createModels(mongoose);
  methods = schemas.createMethods(mongoose);
  storage = (await import('./tokens')).MCPTokenStorage;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function store(binding?: string, actor = userId) {
  const label = binding ?? 'legacy';
  await storage.storeTokens({
    userId: actor,
    serverName,
    binding,
    tokens: {
      access_token: `access-secret-${label}`,
      refresh_token: `refresh-secret-${label}`,
      token_type: 'Bearer',
      expires_in: 3600,
    },
    clientInfo: { client_id: label, client_secret: `client-secret-${label}` },
    metadata: { issuer: `https://${label}.example` },
    createToken: methods.createToken,
    updateToken: methods.updateToken,
    findToken: methods.findToken,
  });
}

const read = (binding?: string, actor = userId) =>
  storage.getTokens({ userId: actor, serverName, binding, findToken: methods.findToken });

beforeEach(async () => {
  await models.Token.deleteMany({});
  await store();
  await store(previous);
});

it('isolates bound access and client records from legacy grants, other targets, and other users', async () => {
  await expect(read(current)).rejects.toThrow('Re-authentication required');
  expect(
    await storage.getClientInfoAndMetadata({
      userId,
      serverName,
      binding: current,
      findToken: methods.findToken,
    }),
  ).toBeNull();
  await store(current);
  expect((await read(current))?.access_token).toBe(`access-secret-${current}`);
  expect((await read(previous))?.access_token).toBe(`access-secret-${previous}`);
  expect((await read())?.access_token).toBe('access-secret-legacy');
  await expect(read(current, otherUserId)).rejects.toThrow('Re-authentication required');
  expect(
    await storage.getClientInfoAndMetadata({
      userId,
      serverName,
      binding: current,
      findToken: methods.findToken,
    }),
  ).toMatchObject({
    clientInfo: { client_id: current, client_secret: `client-secret-${current}` },
    clientMetadata: { issuer: `https://${current}.example` },
  });
  const persisted = JSON.stringify(await models.Token.find().lean());
  expect(persisted).not.toContain('access-secret-');
  expect(persisted).not.toContain('refresh-secret-');
  expect(persisted).not.toContain('client-secret-');
});

it('refreshes expired tokens with the bound registration and persists only into that binding', async () => {
  await store(current);
  await models.Token.updateOne(
    { userId, identifier: `mcp:${serverName}:${current}` },
    { expiresAt: new Date(Date.now() - 1000) },
  );
  const refresh = jest.fn(async () => ({
    access_token: 'refreshed-access',
    refresh_token: 'rotated-refresh',
    token_type: 'Bearer',
    obtained_at: Date.now(),
    expires_at: Date.now() + 3600000,
  }));
  const refreshed = await storage.getTokens({
    userId,
    serverName,
    binding: current,
    findToken: methods.findToken,
    createToken: methods.createToken,
    updateToken: methods.updateToken,
    refreshTokens: refresh,
  });
  expect(refresh).toHaveBeenCalledWith(
    `refresh-secret-${current}`,
    expect.objectContaining({
      identifier: `mcp:${serverName}:${current}`,
      clientInfo: { client_id: current, client_secret: `client-secret-${current}` },
    }),
    undefined,
  );
  expect(refreshed?.access_token).toBe('refreshed-access');
  expect(await read(current)).toMatchObject({
    access_token: 'refreshed-access',
    refresh_token: 'rotated-refresh',
  });
  expect((await read(previous))?.access_token).toBe(`access-secret-${previous}`);
  expect((await read())?.access_token).toBe('access-secret-legacy');
  expect(await models.Token.countDocuments()).toBe(9);
});

it('clears only the bound client and refresh records after invalid_client', async () => {
  await store(current);
  await expect(
    storage.forceRefreshTokens({
      userId,
      serverName,
      binding: current,
      findToken: methods.findToken,
      createToken: methods.createToken,
      updateToken: methods.updateToken,
      deleteTokens: methods.deleteTokens,
      refreshTokens: async () => {
        throw new Error('invalid_client');
      },
    }),
  ).rejects.toThrow('stored client registration is no longer valid');
  expect(
    await storage.getClientInfoAndMetadata({
      userId,
      serverName,
      binding: current,
      findToken: methods.findToken,
    }),
  ).toBeNull();
  expect(
    await methods.findToken({
      userId,
      identifier: `mcp:${serverName}:${current}:refresh`,
    }),
  ).toBeNull();
  expect((await read(previous))?.refresh_token).toBe(`refresh-secret-${previous}`);
  expect((await read())?.refresh_token).toBe('refresh-secret-legacy');
  expect(await models.Token.countDocuments()).toBe(7);
});

it('deletes only the selected user and binding during revocation', async () => {
  await store(current);
  await store(current, otherUserId);
  await storage.deleteUserTokens({
    userId,
    serverName,
    binding: current,
    deleteToken: async (filter) => {
      await methods.deleteTokens(filter);
    },
  });
  await expect(read(current)).rejects.toThrow('Re-authentication required');
  expect((await read(current, otherUserId))?.access_token).toBe(`access-secret-${current}`);
  expect((await read(previous))?.access_token).toBe(`access-secret-${previous}`);
  expect((await read())?.access_token).toBe('access-secret-legacy');
  expect(await models.Token.countDocuments()).toBe(9);
});
