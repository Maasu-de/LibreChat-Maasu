import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  createMethods,
  createModels,
  IUser,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';

interface OAuthTestFixture {
  models: Pick<ReturnType<typeof createModels>, 'Token'>;
  methods: Pick<
    ReturnType<typeof createMethods>,
    'createToken' | 'updateToken' | 'findToken' | 'deleteTokens' | 'findUser'
  >;
  runAsSystem: typeof runAsSystem;
  tenantStorage: typeof tenantStorage;
  reset: () => Promise<IUser>;
  close: () => Promise<void>;
}

const outboxName = 'governance_group_audit_outbox';

export const outbox = () => mongoose.connection.db!.collection(outboxName);

export function failAuditWrites() {
  const database = mongoose.connection.db!;
  const original = database.collection.bind(database);
  return jest.spyOn(database, 'collection').mockImplementation((name, options) => {
    if (name === outboxName) throw new Error('audit unavailable');
    return original(name, options);
  });
}

export async function createOAuthTestFixture(): Promise<OAuthTestFixture> {
  const environment = process.env;
  const replica = await MongoMemoryReplSet.create({
    binary: { version: '8.2.1' },
    replSet: { count: 1 },
  });
  const close = async () => {
    process.env = environment;
    try {
      await mongoose.disconnect();
    } finally {
      await replica.stop();
    }
  };

  try {
    process.env = {
      ...environment,
      CREDS_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      CREDS_IV: '0123456789abcdef0123456789abcdef',
      GOVERNANCE_PILOT_ENABLED: 'true',
      GOVERNANCE_MCP_AUDIT_URL: 'https://governance.example/internal/mcp-audit',
      LIBRECHAT_SERVICE_CREDENTIAL: 'service',
    };
    const schemas = await import('@librechat/data-schemas');
    const models = schemas.createModels(mongoose);
    const methods = schemas.createMethods(mongoose);
    await mongoose.connect(replica.getUri());
    await models.User.createCollection();
    await models.Token.createCollection();
    await mongoose.connection.db!.createCollection(outboxName);

    const reset = () =>
      schemas.runAsSystem(async () => {
        await models.Token.deleteMany({});
        await models.User.deleteMany({});
        await outbox().deleteMany({});
        await mongoose.connection
          .db!.collection('governance_mcp_oauth_authorizations')
          .deleteMany({});
        return models.User.create({
          email: 'admin@test.example',
          provider: 'openid',
          role: 'GOVERNANCE_ADMIN',
          openidId: 'administrator',
          openidIssuer: 'https://identity.example',
        });
      });

    return {
      models,
      methods,
      runAsSystem: schemas.runAsSystem,
      tenantStorage: schemas.tenantStorage,
      reset,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
