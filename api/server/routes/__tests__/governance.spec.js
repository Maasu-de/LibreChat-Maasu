const express = require('express');
const request = require('supertest');

const mockCheckFinanceRead = jest.fn();
const mockGetGovernanceUsage = jest.fn();
const mockTestGovernanceConnection = jest.fn();
const mockResolveUsageLabels = jest.fn();
let mockUser = { id: 'user-123', role: 'USER' };

jest.mock('@librechat/api', () => ({
  generateCheckAccess: (config) => async (req, res, next) => {
    const hasAccess = await mockCheckFinanceRead(config, req);
    if (hasAccess) {
      return next();
    }
    return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
  },
  createGetGovernanceUsage:
    () =>
    (...args) =>
      mockGetGovernanceUsage(...args),
  testGovernanceConnection: (...args) => mockTestGovernanceConnection(...args),
  resolveUsageLabels: (...args) => mockResolveUsageLabels(...args),
}));

jest.mock('../governanceGroups', () => {
  const router = require('express').Router();
  router.requireGovernanceGatewayService = (req, res, next) =>
    req.headers.authorization === 'Bearer gateway-service-secret'
      ? next()
      : res.status(401).json({ message: 'Unauthorized' });
  return router;
});

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = mockUser;
    next();
  },
}));

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  findUsers: jest.fn(),
}));

jest.mock('~/db/models', () => ({
  Group: { find: jest.fn() },
}));

const governanceRoute = require('../governance');

const app = express();
app.use(express.json());
app.use('/api/governance', governanceRoute);

beforeEach(() => {
  mockUser = { id: 'user-123', role: 'USER' };
  mockCheckFinanceRead.mockReset();
  mockGetGovernanceUsage.mockReset();
  mockTestGovernanceConnection.mockReset();
  mockResolveUsageLabels.mockReset();
  mockCheckFinanceRead.mockResolvedValue(false);
  mockGetGovernanceUsage.mockImplementation((_req, res) =>
    res.status(200).json({ totals: { request_count: 0 } }),
  );
  mockTestGovernanceConnection.mockImplementation((_req, res) =>
    res.status(200).json({ status: 'connected' }),
  );
});

describe('POST /api/governance/usage-labels', () => {
  it('requires the Gateway service credential before resolving labels', async () => {
    const response = await request(app).post('/api/governance/usage-labels').send({
      by_user: [],
      by_group: [],
    });

    expect(response.status).toBe(401);
    expect(mockResolveUsageLabels).not.toHaveBeenCalled();
  });

  it('resolves user and group labels for the governance dashboard', async () => {
    const rows = { by_user: [{ key: 'user-key', label: 'user-key' }], by_group: [] };
    mockResolveUsageLabels.mockResolvedValue({
      by_user: [{ key: 'user-key', label: 'Alice' }],
      by_group: [],
    });

    const response = await request(app)
      .post('/api/governance/usage-labels')
      .set('Authorization', 'Bearer gateway-service-secret')
      .send(rows);

    expect(response.status).toBe(200);
    expect(response.body.by_user[0].label).toBe('Alice');
    expect(mockResolveUsageLabels).toHaveBeenCalledWith(rows, {
      findUsers: expect.any(Function),
      findGroups: expect.any(Function),
    });
  });

  it('accepts the earlier team key for existing admin clients', async () => {
    const rows = { by_user: [], by_team: [{ key: 'group-1', label: 'group-1' }] };
    mockResolveUsageLabels.mockResolvedValue({
      by_user: [],
      by_group: [{ key: 'group-1', label: 'Finance' }],
    });

    const response = await request(app)
      .post('/api/governance/usage-labels')
      .set('Authorization', 'Bearer gateway-service-secret')
      .send(rows);

    expect(response.status).toBe(200);
    expect(response.body.by_team[0].label).toBe('Finance');
    expect(mockResolveUsageLabels).toHaveBeenCalledWith(
      { by_user: [], by_group: rows.by_team },
      { findUsers: expect.any(Function), findGroups: expect.any(Function) },
    );
  });
});

describe('GET /api/governance/usage', () => {
  it('allows users with the finance read grant to read usage', async () => {
    mockUser = { id: 'user-123', role: 'finance-reader' };
    mockCheckFinanceRead.mockResolvedValue(true);

    const response = await request(app).get(
      '/api/governance/usage?start_date=2026-09-01&end_date=2026-09-11',
    );

    expect(response.status).toBe(200);
    expect(mockCheckFinanceRead).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionType: 'FINANCE',
        permissions: ['READ'],
      }),
      expect.objectContaining({
        query: { start_date: '2026-09-01', end_date: '2026-09-11' },
      }),
    );
    expect(mockGetGovernanceUsage).toHaveBeenCalledTimes(1);
  });

  it('blocks users without finance authorization before proxying usage', async () => {
    const response = await request(app).get('/api/governance/usage');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'Forbidden: Insufficient permissions' });
    expect(mockGetGovernanceUsage).not.toHaveBeenCalled();
  });
});

describe('GET /api/governance/health', () => {
  it('delegates the authenticated connection test to the API handler', async () => {
    const response = await request(app).get('/api/governance/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'connected' });
    expect(mockTestGovernanceConnection).toHaveBeenCalledTimes(1);
  });
});
