import jwt from 'jsonwebtoken';
import express from 'express';
import jwksRsa from 'jwks-rsa';
import request from 'supertest';
import { Types } from 'mongoose';
import { generateKeyPairSync } from 'crypto';
import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { GovernanceGroupsDeps } from '../groups';
import {
  createListGovernanceGroups,
  createRequireGovernanceAdminToken,
  clearGovernanceJwksCache,
  createGetUserGroupIds,
} from '../groups';

const mockGetSigningKey = jest.fn();

jest.mock('jwks-rsa', () =>
  jest.fn(() => ({ getSigningKey: (...args: unknown[]) => mockGetSigningKey(...args) })),
);

const ISSUER = 'http://keycloak:8080/realms/ai-governance';
const CLIENT_ID = 'governance-web';
const ADMIN_ROLE = 'governance-admin';
const KID = 'test-kid';

const keyPair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
const realmKeys = keyPair();
const foreignKeys = keyPair();

type TokenOptions = {
  issuer?: string;
  roles?: string[];
  typ?: string;
  privateKey?: string;
  claims?: jwt.JwtPayload;
};

const signToken = ({
  issuer = ISSUER,
  roles = [ADMIN_ROLE],
  typ = 'Bearer',
  privateKey = realmKeys.privateKey,
  claims = {},
}: TokenOptions = {}) =>
  jwt.sign({ sub: 'admin-subject', typ, realm_access: { roles }, ...claims }, privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    issuer,
    audience: CLIENT_ID,
    expiresIn: 60,
  });

const objectId = (n: number) => n.toString(16).padStart(24, '0');
const group = (id: string, name: string) => ({ _id: new Types.ObjectId(id), name });
const listGroups = jest.fn() as jest.MockedFunction<GovernanceGroupsDeps['listGroups']>;
const exchangeAccessToken = jest.fn<Promise<string>, [string, string]>();

const app = express();
app.get(
  '/api/governance/groups',
  createRequireGovernanceAdminToken({ exchangeAccessToken }),
  createListGovernanceGroups({ listGroups }),
);

const getGroups = (token?: string) => {
  const req = request(app).get('/api/governance/groups');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv };
  clearGovernanceJwksCache();
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => realmKeys.publicKey });
  process.env.OPENID_ISSUER = ISSUER;
  process.env.GOVERNANCE_ADMIN_CLIENT_ID = CLIENT_ID;
  process.env.OPENID_ADMIN_ROLE = ADMIN_ROLE;
  exchangeAccessToken.mockReset().mockImplementation(async (token) => token);
});

afterAll(() => {
  process.env = savedEnv;
});

describe('GET /api/governance/groups', () => {
  it('lists group ids and names for a valid governance-admin token', async () => {
    listGroups.mockResolvedValueOnce([group(objectId(1), 'Engineering'), group(objectId(2), 'HR')]);

    const response = await getGroups(signToken());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      groups: [
        { id: objectId(1), name: 'Engineering' },
        { id: objectId(2), name: 'HR' },
      ],
    });
    expect(mockGetSigningKey).toHaveBeenCalledWith(KID);
  });

  it('follows pagination until a short page', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) =>
      group(objectId(index + 10), `Group ${index}`),
    );
    listGroups.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([group(objectId(9), 'Last')]);

    const response = await getGroups(signToken());

    expect(response.body.groups).toHaveLength(201);
    expect(listGroups).toHaveBeenNthCalledWith(1, { limit: 200, offset: 0 });
    expect(listGroups).toHaveBeenNthCalledWith(2, { limit: 200, offset: 200 });
  });

  it('queries groups in system tenant scope', async () => {
    const tenants: Array<string | undefined> = [];
    listGroups.mockImplementationOnce(async () => {
      tenants.push(getTenantId());
      return [group(objectId(1), 'Engineering')];
    });

    const response = await getGroups(signToken());

    expect(response.status).toBe(200);
    expect(tenants).toEqual([SYSTEM_TENANT_ID]);
  });

  it.each(['access', 'id'])(
    'uses a customer nested administrator claim from %s tokens',
    async (source) => {
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'company.permissions';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = source;
      process.env.OPENID_ADMIN_ROLE = 'company-admin';
      listGroups.mockResolvedValue([]);
      const response = await getGroups(
        signToken({
          roles: [],
          typ: source === 'id' ? 'ID' : 'Bearer',
          claims: { company: { permissions: ['company-admin'] } },
        }),
      );
      expect(response.status).toBe(200);
      const revoked = await getGroups(signToken({ claims: { company: { permissions: [] } } }));
      expect(revoked.status).toBe(401);
    },
  );

  it('reads administrator entitlement from subject-bound userinfo', async () => {
    process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'company.admin';
    process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';
    listGroups.mockResolvedValue([]);
    const userinfo = jest.spyOn(global, 'fetch').mockResolvedValue(
      Response.json({
        sub: 'admin-subject',
        company: { admin: true },
      }),
    );
    try {
      expect((await getGroups(signToken({ roles: [] }))).status).toBe(200);
      userinfo.mockResolvedValueOnce(Response.json({ sub: 'other', company: { admin: true } }));
      expect((await getGroups(signToken())).status).toBe(401);
    } finally {
      userinfo.mockRestore();
    }
  });

  it('queries the configured userinfo endpoint with the exchanged token', async () => {
    process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';
    process.env.OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED = 'true';
    process.env.OIDC_USERINFO_URI = 'https://identity.company.test/custom-userinfo';
    exchangeAccessToken.mockResolvedValue('exchanged-userinfo-token');
    listGroups.mockResolvedValue([]);
    const userinfo = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json({ sub: 'admin-subject', realm_access: { roles: [ADMIN_ROLE] } }),
      );
    const token = signToken({ roles: [] });
    try {
      expect((await getGroups(token)).status).toBe(200);
      expect(exchangeAccessToken).toHaveBeenCalledWith(token, 'admin-subject');
      expect(userinfo).toHaveBeenCalledWith(
        process.env.OIDC_USERINFO_URI,
        expect.objectContaining({
          headers: { authorization: 'Bearer exchanged-userinfo-token' },
        }),
      );
      userinfo.mockResolvedValueOnce(
        Response.json({ sub: 'other', realm_access: { roles: [ADMIN_ROLE] } }),
      );
      expect((await getGroups(token)).status).toBe(401);
    } finally {
      userinfo.mockRestore();
    }
  });

  it('does not send the original token to userinfo if the exchange fails', async () => {
    process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';
    process.env.OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED = 'true';
    exchangeAccessToken.mockRejectedValue(new Error('OBO unavailable'));
    const userinfo = jest.spyOn(global, 'fetch');
    try {
      expect((await getGroups(signToken())).status).toBe(401);
      expect(userinfo).not.toHaveBeenCalled();
      expect(listGroups).not.toHaveBeenCalled();
    } finally {
      userinfo.mockRestore();
    }
  });

  it.each(['Bearer', 'Refresh', 'other', undefined])(
    'rejects token type %s when ID-token claims are authoritative',
    async (typ) => {
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';

      const response = await getGroups(signToken({ claims: { typ } }));

      expect(response.status).toBe(401);
      expect(listGroups).not.toHaveBeenCalled();
    },
  );

  it.each(['access', 'userinfo'])(
    'rejects ID tokens when %s claims are authoritative',
    async (source) => {
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = source;
      const userinfo = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          Response.json({ sub: 'admin-subject', realm_access: { roles: [ADMIN_ROLE] } }),
        );
      try {
        const response = await getGroups(signToken({ typ: 'ID' }));

        expect(response.status).toBe(401);
        expect(listGroups).not.toHaveBeenCalled();
      } finally {
        userinfo.mockRestore();
      }
    },
  );

  it('preserves a customer issuer trailing slash from validated discovery metadata', async () => {
    const issuer = 'https://identity.company.test/';
    process.env.OPENID_ISSUER = issuer;
    listGroups.mockResolvedValue([]);
    const discovery = jest.spyOn(global, 'fetch').mockResolvedValue(
      Response.json({
        issuer,
        jwks_uri: 'https://identity.company.test/jwks',
      }),
    );
    try {
      expect((await getGroups(signToken({ issuer }))).status).toBe(200);
    } finally {
      discovery.mockRestore();
    }
  });

  it('rejects a missing token without querying groups', async () => {
    const response = await getGroups();

    expect(response.status).toBe(401);
    expect(mockGetSigningKey).not.toHaveBeenCalled();
    expect(listGroups).not.toHaveBeenCalled();
  });

  it.each([
    ['is signed by a different key', { privateKey: foreignKeys.privateKey }],
    ['comes from a different issuer', { issuer: 'http://keycloak:8080/realms/other' }],
    ['lacks the governance-admin role', { roles: ['governance-user'] }],
    ['is not an access token', { typ: 'Refresh' }],
  ])('rejects a token that %s', async (_label, options: TokenOptions) => {
    const response = await getGroups(signToken(options));

    expect(response.status).toBe(401);
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('rejects a token without a key id', async () => {
    const token = jwt.sign({ typ: 'Bearer' }, realmKeys.privateKey, { algorithm: 'RS256' });

    const response = await getGroups(token);

    expect(response.status).toBe(401);
    expect(mockGetSigningKey).not.toHaveBeenCalled();
  });

  it('is unavailable when OIDC verification is not configured', async () => {
    delete process.env.GOVERNANCE_ADMIN_CLIENT_ID;

    const response = await getGroups(signToken());

    expect(response.status).toBe(503);
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('reports a server error without leaking details when the lookup fails', async () => {
    listGroups.mockRejectedValueOnce(new Error('mongo exploded'));

    const response = await getGroups(signToken());

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('mongo');
  });

  it('reuses one JWKS client per issuer and builds a new one when the issuer changes', async () => {
    listGroups.mockResolvedValue([]);
    const otherIssuer = 'http://keycloak:8080/realms/other';

    await getGroups(signToken());
    await getGroups(signToken());
    process.env.OPENID_ISSUER = `${otherIssuer}/`;
    await getGroups(signToken({ issuer: otherIssuer }));

    expect(jwksRsa).toHaveBeenCalledTimes(2);
    expect(jwksRsa).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ jwksUri: `${ISSUER}/protocol/openid-connect/certs` }),
    );
    expect(jwksRsa).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ jwksUri: `${otherIssuer}/protocol/openid-connect/certs` }),
    );
  });

  it('accepts OPENID_ISSUER in discovery-URL form', async () => {
    listGroups.mockResolvedValueOnce([]);
    process.env.OPENID_ISSUER = `${ISSUER}/.well-known/openid-configuration`;

    const response = await getGroups(signToken());

    expect(response.status).toBe(200);
    expect(jwksRsa).toHaveBeenCalledWith(
      expect.objectContaining({ jwksUri: `${ISSUER}/protocol/openid-connect/certs` }),
    );
  });
});

describe('createGetUserGroupIds', () => {
  it('returns the string ids of the groups a user belongs to', async () => {
    const getUserGroups = jest
      .fn()
      .mockResolvedValue([group(objectId(1), 'A'), group(objectId(2), 'B')]);

    const ids = await createGetUserGroupIds({ getUserGroups })('user-123');

    expect(ids).toEqual([objectId(1), objectId(2)]);
    expect(getUserGroups).toHaveBeenCalledWith('user-123', { _id: 1 });
  });
});
