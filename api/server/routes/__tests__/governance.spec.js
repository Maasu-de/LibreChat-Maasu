const express = require('express');
const request = require('supertest');

const mockCheckTextSubmission = jest.fn();
const mockIsGovernanceDlpEnabled = jest.fn();
const mockTestGovernanceConnection = jest.fn();

jest.mock('@librechat/api', () => ({
  checkTextSubmission: (...args) => mockCheckTextSubmission(...args),
  createDlpFailure: () => ({
    status: 503,
    body: { type: 'governance_unavailable', message: 'DLP unavailable' },
  }),
  isGovernanceDlpEnabled: () => mockIsGovernanceDlpEnabled(),
  testGovernanceConnection: (...args) => mockTestGovernanceConnection(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-123' };
    next();
  },
}));

const governanceRoute = require('../governance');

const app = express();
app.use(express.json());
app.use('/api/governance', governanceRoute);

beforeEach(() => {
  mockCheckTextSubmission.mockReset();
  mockIsGovernanceDlpEnabled.mockReset();
  mockTestGovernanceConnection.mockReset();
  mockIsGovernanceDlpEnabled.mockReturnValue(true);
  mockTestGovernanceConnection.mockImplementation((_req, res) =>
    res.status(200).json({ status: 'connected' }),
  );
});

describe('GET /api/governance/health', () => {
  it('delegates the authenticated connection test to the API handler', async () => {
    const response = await request(app).get('/api/governance/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'connected' });
    expect(mockTestGovernanceConnection).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/governance/dlp/check', () => {
  it('returns a disabled response without contacting the gateway', async () => {
    mockIsGovernanceDlpEnabled.mockReturnValue(false);

    const response = await request(app)
      .post('/api/governance/dlp/check')
      .send({ text: 'hello', model: 'company-assistant' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: false });
    expect(mockCheckTextSubmission).not.toHaveBeenCalled();
  });

  it('returns safe finding and preview data without exposing the DLP token', async () => {
    mockCheckTextSubmission.mockResolvedValue({
      decision: 'MASK',
      policyVersion: 4,
      findings: [
        {
          location: '/messages/0/content',
          start: 8,
          end: 20,
          category: 'PROJECT_NAME',
          action: 'MASK',
          replacement: '[CONFIDENTIAL]',
        },
      ],
      maskedPreview: [{ location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' }],
      dlpToken: 'server-only-token',
    });

    const response = await request(app)
      .post('/api/governance/dlp/check')
      .send({ text: 'Discuss Project Acme now', model: 'company-assistant' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      decision: 'MASK',
      policyVersion: 4,
      maskedPreview: [{ location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' }],
    });
    expect(response.body).not.toHaveProperty('dlpToken');
    expect(mockCheckTextSubmission).toHaveBeenCalledWith({
      text: 'Discuss Project Acme now',
      model: 'company-assistant',
      userId: 'user-123',
    });
  });

  it.each([
    [{ text: '', model: 'company-assistant' }, 'Text'],
    [{ text: 'hello', model: '' }, 'Model'],
  ])('rejects invalid input %#', async (body, field) => {
    const response = await request(app).post('/api/governance/dlp/check').send(body);

    expect(response.status).toBe(400);
    expect(response.body.message).toContain(field);
    expect(mockCheckTextSubmission).not.toHaveBeenCalled();
  });

  it('fails closed without exposing internal errors', async () => {
    mockCheckTextSubmission.mockRejectedValue(new Error('gateway secret detail'));

    const response = await request(app)
      .post('/api/governance/dlp/check')
      .send({ text: 'hello', model: 'company-assistant' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      type: 'governance_unavailable',
      message: 'DLP unavailable',
    });
    expect(JSON.stringify(response.body)).not.toContain('gateway secret detail');
  });
});
