const express = require('express');
const request = require('supertest');

const mockListGroups = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('~/models', () => ({
  listGroups: (...args) => mockListGroups(...args),
}));

const governanceGroupsRoute = require('../governanceGroups');

const app = express();
app.use('/api/governance/groups', governanceGroupsRoute);

const CREDENTIAL = 'test-group-lookup-credential';
const group = (id, name, source = 'local') => ({ _id: { toString: () => id }, name, source });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LIBRECHAT_GROUP_LOOKUP_CREDENTIAL = CREDENTIAL;
});

afterAll(() => {
  delete process.env.LIBRECHAT_GROUP_LOOKUP_CREDENTIAL;
});

describe('GET /api/governance/groups', () => {
  it('lists group ids and names for the service credential', async () => {
    mockListGroups.mockResolvedValueOnce([group('a1', 'Engineering'), group('b2', 'HR')]);

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${CREDENTIAL}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      groups: [
        { id: 'a1', name: 'Engineering', source: 'local' },
        { id: 'b2', name: 'HR', source: 'local' },
      ],
    });
  });

  it('follows pagination until a short page', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) => group(`g${index}`, `Group ${index}`));
    mockListGroups.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([group('last', 'Last')]);

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${CREDENTIAL}`);

    expect(response.body.groups).toHaveLength(201);
    expect(mockListGroups).toHaveBeenNthCalledWith(1, { limit: 200, offset: 0 });
    expect(mockListGroups).toHaveBeenNthCalledWith(2, { limit: 200, offset: 200 });
  });

  it('rejects a missing or wrong credential without querying groups', async () => {
    const missing = await request(app).get('/api/governance/groups');
    const wrong = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', 'Bearer not-the-credential');

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it('is unavailable when no credential is configured', async () => {
    delete process.env.LIBRECHAT_GROUP_LOOKUP_CREDENTIAL;

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', 'Bearer anything');

    expect(response.status).toBe(503);
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it('reports a server error without leaking details when the lookup fails', async () => {
    mockListGroups.mockRejectedValueOnce(new Error('mongo exploded'));

    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${CREDENTIAL}`);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('mongo');
  });
});
