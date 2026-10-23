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
    process.env.GOVERNANCE_GATEWAY_SERVICE_CREDENTIAL = 'gateway-service-secret';
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('guards the group lookup with the Gateway service credential', async () => {
    const response = await request(app).get('/api/governance/groups');

    expect(response.status).toBe(401);
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it('allows the configured Gateway service credential', async () => {
    mockListGroups.mockResolvedValue([]);

    const response = await request(app)
      .get('/api/governance/groups')
      .auth('gateway-service-secret', { type: 'bearer' });

    expect(response.status).toBe(200);
    expect(mockListGroups).toHaveBeenCalled();
  });
});
