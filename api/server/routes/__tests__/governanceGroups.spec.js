const express = require('express');
const request = require('supertest');

const mockListGroups = jest.fn();

jest.mock('~/models', () => ({
  listGroups: (...args) => mockListGroups(...args),
}));

const governanceGroupsRoute = require('../governanceGroups');

const app = express();
app.use('/api/governance/groups', governanceGroupsRoute);

describe('GET /api/governance/groups', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.OPENID_ISSUER = 'http://keycloak:8080/realms/ai-governance';
    process.env.GOVERNANCE_ADMIN_CLIENT_ID = 'governance-web';
    process.env.OPENID_ADMIN_ROLE = 'governance-admin';
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('guards the group lookup with the governance admin token check', async () => {
    const response = await request(app).get('/api/governance/groups');

    expect(response.status).toBe(401);
    expect(mockListGroups).not.toHaveBeenCalled();
  });
});
