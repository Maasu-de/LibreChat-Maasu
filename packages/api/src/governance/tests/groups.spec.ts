import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { GovernanceGroupsDeps } from '../groups';
import {
  createGetUserGroupIds,
  createListGovernanceGroups,
  requireGovernanceGatewayService,
} from '../groups';

const CREDENTIAL = 'gateway-to-librechat-secret';
const objectId = (n: number) => n.toString(16).padStart(24, '0');
const group = (id: string, name: string) => ({ _id: new Types.ObjectId(id), name });
const listGroups = jest.fn() as jest.MockedFunction<GovernanceGroupsDeps['listGroups']>;

const app = express();
app.get(
  '/api/governance/groups',
  requireGovernanceGatewayService,
  createListGovernanceGroups({ listGroups }),
);

const getGroups = (credential?: string) => {
  const req = request(app).get('/api/governance/groups');
  return credential ? req.set('Authorization', `Bearer ${credential}`) : req;
};

const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...savedEnv,
    GOVERNANCE_GATEWAY_SERVICE_CREDENTIAL: CREDENTIAL,
    LIBRECHAT_SERVICE_CREDENTIAL: 'librechat-to-gateway-secret',
  };
});

afterAll(() => {
  process.env = savedEnv;
});

describe('GET /api/governance/groups', () => {
  it('lists group ids and names for the trusted Governance Gateway', async () => {
    listGroups.mockResolvedValueOnce([group(objectId(1), 'Engineering'), group(objectId(2), 'HR')]);

    const response = await getGroups(CREDENTIAL);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      groups: [
        { id: objectId(1), name: 'Engineering' },
        { id: objectId(2), name: 'HR' },
      ],
    });
  });

  it('follows pagination until a short page', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) =>
      group(objectId(index + 10), `Group ${index}`),
    );
    listGroups.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([group(objectId(9), 'Last')]);

    const response = await getGroups(CREDENTIAL);

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

    const response = await getGroups(CREDENTIAL);

    expect(response.status).toBe(200);
    expect(tenants).toEqual([SYSTEM_TENANT_ID]);
  });

  it.each([
    ['missing', undefined],
    ['incorrect', 'wrong-secret'],
    ['reverse-direction', 'librechat-to-gateway-secret'],
  ])('rejects a %s service credential', async (_label, credential) => {
    const response = await getGroups(credential);

    expect(response.status).toBe(401);
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('rejects malformed bearer authentication', async () => {
    const response = await request(app)
      .get('/api/governance/groups')
      .set('Authorization', `Bearer ${CREDENTIAL} extra`);

    expect(response.status).toBe(401);
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('is unavailable when the dedicated credential is not configured', async () => {
    delete process.env.GOVERNANCE_GATEWAY_SERVICE_CREDENTIAL;

    const response = await getGroups(CREDENTIAL);

    expect(response.status).toBe(503);
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('reports a server error without leaking details when the lookup fails', async () => {
    listGroups.mockRejectedValueOnce(new Error('mongo exploded'));

    const response = await getGroups(CREDENTIAL);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('mongo');
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
