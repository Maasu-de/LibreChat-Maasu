import express from 'express';
import request from 'supertest';
import { SystemCapabilities } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import { generateCapabilityCheck } from '../../middleware/capabilities';

const deps = {
  getUserPrincipals: jest.fn(async () => []),
  hasCapabilityForPrincipals: jest.fn(async () => true),
};
const { requireCapability, hasCapability } = generateCapabilityCheck(deps);
const app = express();
app.use((req, _res, next) => {
  (req as ServerRequest).user = {
    id: 'administrator',
    role: 'GOVERNANCE_ADMIN',
    provider: 'openid',
  } as ServerRequest['user'];
  next();
});
app.use('/api/admin', (req, res, next) => {
  void requireCapability(SystemCapabilities.ACCESS_ADMIN)(req as ServerRequest, res, next);
});
app.use((_req, res) => {
  res.sendStatus(204);
});

it.each([
  '/api/admin/config',
  '/api/admin/users',
  '/api/admin/users/123',
  '/api/admin/users/search',
  '/api/admin/grants/effective',
  '/api/admin/roles',
  '/api/admin/grants',
  '/api/admin/audit',
  '/api/admin/skills',
])('denies non-group admin API %s even with broad grants', async (path) => {
  for (const method of ['get', 'post', 'patch', 'delete'] as const) {
    expect((await request(app)[method](path)).status).toBe(403);
  }
});

it.each([
  '/api/admin/groups',
  '/api/admin/groups/capabilities',
  '/api/admin/groups/users/search',
  '/api/admin/groups/group-id',
  '/api/admin/groups/group-id/members',
  '/api/admin/groups/group-id/members/user-id',
])('permits the groups API %s', async (path) => {
  expect((await request(app).get(path)).status).toBe(204);
  expect((await request(app).post(path)).status).toBe(204);
});

it.each(['/api/admin/verify'])(
  'allows only reads for group-editor support API %s',
  async (path) => {
    expect((await request(app).get(path)).status).toBe(204);
    expect((await request(app).post(path)).status).toBe(403);
  },
);

it('does not inherit unrelated direct or group grants', async () => {
  const user = { id: 'administrator', role: 'GOVERNANCE_ADMIN' };
  expect(await hasCapability(user, SystemCapabilities.MANAGE_GROUPS)).toBe(true);
  for (const capability of [
    SystemCapabilities.READ_USERS,
    SystemCapabilities.MANAGE_USERS,
    SystemCapabilities.MANAGE_ROLES,
    SystemCapabilities.MANAGE_CONFIGS,
    SystemCapabilities.READ_AUDIT_LOG,
  ]) {
    expect(await hasCapability(user, capability)).toBe(false);
  }
  expect(deps.hasCapabilityForPrincipals).not.toHaveBeenCalled();
});
