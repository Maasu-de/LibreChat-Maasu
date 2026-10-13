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
  requireGovernanceAdminToken,
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
};

const signToken = ({
  issuer = ISSUER,
  roles = [ADMIN_ROLE],
  typ = 'Bearer',
  privateKey = realmKeys.privateKey,
}: TokenOptions = {}) =>
  jwt.sign({ typ, realm_access: { roles } }, privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    issuer,
    audience: CLIENT_ID,
    expiresIn: 60,
  });

const objectId = (n: number) => n.toString(16).padStart(24, '0');
const group = (id: string, name: string) => ({ _id: new Types.ObjectId(id), name });
const listGroups = jest.fn() as jest.MockedFunction<GovernanceGroupsDeps['listGroups']>;

const app = express();
app.get(
  '/api/governance/groups',
  requireGovernanceAdminToken,
  createListGovernanceGroups({ listGroups }),
);

const getGroups = (token?: string) => {
  const req = request(app).get('/api/governance/groups');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  clearGovernanceJwksCache();
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => realmKeys.publicKey });
  process.env.OPENID_ISSUER = ISSUER;
  process.env.GOVERNANCE_ADMIN_CLIENT_ID = CLIENT_ID;
  process.env.OPENID_ADMIN_ROLE = ADMIN_ROLE;
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
