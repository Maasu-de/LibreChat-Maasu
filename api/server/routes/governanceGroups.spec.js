const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const { generateKeyPairSync } = require('node:crypto');
const { clearGovernanceJwksCache } = require('@librechat/api');
const { getOpenIdConfig, exchangeAccessTokenIfNeeded } = require('~/strategies');
const { listGroups } = require('~/models');
const governanceGroups = require('./governanceGroups');

const mockGetSigningKey = jest.fn();
jest.mock('jwks-rsa', () =>
  jest.fn(() => ({ getSigningKey: (...args) => mockGetSigningKey(...args) })),
);
jest.mock('~/models', () => ({ listGroups: jest.fn() }));
jest.mock('~/strategies', () => ({
  getOpenIdConfig: jest.fn(() => ({ client: 'configured-oidc-client' })),
  exchangeAccessTokenIfNeeded: jest.fn(),
}));

const environment = process.env;
const issuer = 'https://identity.example/realms/company';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const app = express();
app.use('/api/governance/groups', governanceGroups);
let userinfo;

beforeEach(() => {
  jest.clearAllMocks();
  clearGovernanceJwksCache();
  process.env = {
    ...environment,
    OPENID_ISSUER: issuer,
    GOVERNANCE_ADMIN_CLIENT_ID: 'governance-web',
    OPENID_ADMIN_ROLE: 'company-admin',
    OPENID_ADMIN_ROLE_PARAMETER_PATH: 'company.permissions',
    OPENID_ADMIN_ROLE_TOKEN_KIND: 'userinfo',
    OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED: 'true',
    OIDC_USERINFO_URI: 'https://identity.example/custom-userinfo',
  };
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => keys.publicKey });
  exchangeAccessTokenIfNeeded.mockReset().mockResolvedValue('exchanged-userinfo-token');
  listGroups.mockReset().mockResolvedValue([]);
  userinfo = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      Response.json({ sub: 'admin-subject', company: { permissions: ['company-admin'] } }),
    );
});

afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

function getGroups() {
  const token = jwt.sign({ sub: 'admin-subject', typ: 'Bearer' }, keys.privateKey, {
    algorithm: 'RS256',
    keyid: 'test-key',
    issuer,
    audience: 'governance-web',
    expiresIn: 60,
  });
  return {
    token,
    response: request(app).get('/api/governance/groups').auth(token, { type: 'bearer' }),
  };
}

it('exchanges the verified governance token using the configured OIDC client', async () => {
  const { token, response } = getGroups();

  expect((await response).status).toBe(200);
  expect(exchangeAccessTokenIfNeeded).toHaveBeenCalledWith(
    getOpenIdConfig(),
    token,
    'admin-subject',
  );
  expect(userinfo).toHaveBeenCalledWith(
    process.env.OIDC_USERINFO_URI,
    expect.objectContaining({ headers: { authorization: 'Bearer exchanged-userinfo-token' } }),
  );
  expect(listGroups).toHaveBeenCalled();
});

it('reports authentication unavailable when the configured OBO exchange fails', async () => {
  exchangeAccessTokenIfNeeded.mockRejectedValueOnce(new Error('Token exchange rejected'));

  expect((await getGroups().response).status).toBe(503);
  expect(userinfo).not.toHaveBeenCalled();
  expect(listGroups).not.toHaveBeenCalled();
});

it('denies userinfo for a different subject after exchange', async () => {
  userinfo.mockResolvedValueOnce(
    Response.json({ sub: 'other', company: { permissions: ['company-admin'] } }),
  );

  expect((await getGroups().response).status).toBe(401);
  expect(listGroups).not.toHaveBeenCalled();
});
