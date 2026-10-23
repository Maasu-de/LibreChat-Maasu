const express = require('express');
const request = require('supertest');
const { SystemCapabilities } = require('@librechat/data-schemas');

let mockRole = 'GOVERNANCE_ADMIN';

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  startGovernanceGroupAuditDelivery: jest.fn(),
}));
jest.mock('~/models', () => ({ findUsers: jest.fn() }));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'governance-admin', provider: 'openid', role: mockRole };
    next();
  },
}));
jest.mock('~/server/middleware/roles/capabilities', () => {
  const { generateCapabilityCheck } = require('@librechat/api');
  return generateCapabilityCheck({
    getUserPrincipals: async () => [],
    hasCapabilityForPrincipals: async ({ capability }) => capability !== 'manage:groups',
  });
});

const { findUsers } = require('~/models');
const groups = require('./groups');
const app = express();
app.use('/api/admin/groups', groups);

it('returns only group capabilities through the group-scoped endpoint', async () => {
  const response = await request(app).get('/api/admin/groups/capabilities');
  expect(response.status).toBe(200);
  expect(response.body.capabilities).toEqual([
    SystemCapabilities.ACCESS_ADMIN,
    SystemCapabilities.READ_GROUPS,
    SystemCapabilities.MANAGE_GROUPS,
  ]);
});

it('finds membership candidates using the bounded search handler', async () => {
  findUsers.mockResolvedValueOnce([
    {
      _id: 'user-id',
      name: 'Alex',
      email: 'alex@example.test',
      role: 'ADMIN',
      password: 'private',
    },
  ]);
  const response = await request(app).get('/api/admin/groups/users/search?q=Alex');
  expect(response.status).toBe(200);
  expect(response.body.users).toEqual([
    { id: 'user-id', name: 'Alex', email: 'alex@example.test' },
  ]);
  expect(findUsers).toHaveBeenCalledWith(expect.any(Object), '_id name email username avatar', {
    limit: 20,
    sort: { name: 1 },
  });
});

it('does not advertise management to a delegated reader outside the pilot', async () => {
  mockRole = 'group-reader';
  try {
    const response = await request(app).get('/api/admin/groups/capabilities');
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toEqual([
      SystemCapabilities.ACCESS_ADMIN,
      SystemCapabilities.READ_GROUPS,
    ]);
  } finally {
    mockRole = 'GOVERNANCE_ADMIN';
  }
});
