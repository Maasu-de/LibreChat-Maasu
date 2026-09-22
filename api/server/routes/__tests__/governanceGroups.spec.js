const express = require('express');
const request = require('supertest');

const mockListGroups = jest.fn();
const mockGetSigningKey = jest.fn((_kid, callback) =>
  callback(null, { getPublicKey: () => 'test-public-key' }),
);
const mockDecode = jest.fn(() => ({ header: { kid: 'test-kid' } }));
const mockVerify = jest.fn(() => ({
  typ: 'Bearer',
  realm_access: { roles: ['governance-admin'] },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));

jest.mock('~/models', () => ({
  listGroups: (...args) => mockListGroups(...args),
}));

jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: (...args) => mockGetSigningKey(...args) })));

jest.mock('jsonwebtoken', () => ({
  decode: (...args) => mockDecode(...args),
  verify: (...args) => mockVerify(...args),
}));

const governanceGroupsRoute = require('../governanceGroups');

const app = express();
app.use('/api/governance/groups', governanceGroupsRoute);

const ISSUER = 'http://keycloak:8080/realms/ai-governance';
const CLIENT_ID = 'governance-web';
const ADMIN_ROLE = 'governance-admin';
const TOKEN = 'test-admin-token';
const group = (id, name, source = 'local') => ({ _id: { toString: () => id }, name, source });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSigningKey.mockImplementation((_kid, callback) =>
    callback(null, { getPublicKey: () => 'test-public-key' }),
  );
  mockDecode.mockReturnValue({ header: { kid: 'test-kid' } });
  mockVerify.mockReturnValue({ typ: 'Bearer', realm_access: { roles: [ADMIN_ROLE] } });
  process.env.OPENID_ISSUER = ISSUER;
  process.env.GOVERNANCE_ADMIN_CLIENT_ID = CLIENT_ID;
  process.env.OPENID_ADMIN_ROLE = ADMIN_ROLE;
});

afterAll(() => {
  delete process.env.OPENID_ISSUER;
  delete process.env.GOVERNANCE_ADMIN_CLIENT_ID;
  delete process.env.OPENID_ADMIN_ROLE;
});

describe('GET /api/governance/groups', () => {
  it('lists group ids and names for a valid governance-admin token', async () => {
    mockListGroups.mockResolvedValueOnce([group('a1', 'Engineering'), group('b2', 'HR')]);

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      groups: [
        { id: 'a1', name: 'Engineering', source: 'local' },
        { id: 'b2', name: 'HR', source: 'local' },
      ],
    });
    expect(mockVerify).toHaveBeenCalledWith(TOKEN, 'test-public-key', {
      algorithms: ['RS256'],
      issuer: ISSUER,
      audience: CLIENT_ID,
    });
  });

  it('follows pagination until a short page', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) => group(`g${index}`, `Group ${index}`));
    mockListGroups.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([group('last', 'Last')]);

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.body.groups).toHaveLength(201);
    expect(mockListGroups).toHaveBeenNthCalledWith(1, { limit: 200, offset: 0 });
    expect(mockListGroups).toHaveBeenNthCalledWith(2, { limit: 200, offset: 200 });
  });

  it('rejects a missing token without querying groups', async () => {
    const response = await request(app).get('/api/governance/groups');

    expect(response.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it('rejects a token that fails signature or issuer verification', async () => {
    mockVerify.mockImplementationOnce(() => {
      throw new Error('jwt issuer invalid');
    });

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(401);
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it('rejects a verified token that lacks the governance-admin role', async () => {
    mockVerify.mockReturnValueOnce({ typ: 'Bearer', realm_access: { roles: ['governance-user'] } });

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(401);
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it('is unavailable when OIDC verification is not configured', async () => {
    delete process.env.GOVERNANCE_ADMIN_CLIENT_ID;

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(503);
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it('reports a server error without leaking details when the lookup fails', async () => {
    mockListGroups.mockRejectedValueOnce(new Error('mongo exploded'));

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('mongo');
  });
});
