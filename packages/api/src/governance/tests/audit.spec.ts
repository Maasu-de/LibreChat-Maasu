import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels, createMethods, runAsSystem } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import { createAdminGroupsHandlers } from '../../admin/groups';
import { flushGovernanceGroupAudit, startGovernanceGroupAuditDelivery } from '../audit';

const environment = process.env;
let replica: MongoMemoryReplSet;
let actor: IUser;
const models = createModels(mongoose);
const methods = createMethods(mongoose);
const handlers = createAdminGroupsHandlers({
  ...methods,
  listGroups: (filter = {}) =>
    methods.listGroups({ ...filter, source: filter.source === 'entra' ? 'entra' : undefined }),
  countGroups: (filter = {}) =>
    methods.countGroups({ ...filter, source: filter.source === 'entra' ? 'entra' : undefined }),
});
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as ServerRequest).user = actor;
  void runAsSystem(async () => {
    next();
  });
});
app.post('/groups', async (req, res) => {
  await handlers.createGroup(req as ServerRequest, res);
});
app.patch('/groups/:id', async (req, res) => {
  await handlers.updateGroup(req as ServerRequest, res);
});
app.delete('/groups/:id', async (req, res) => {
  await handlers.deleteGroup(req as ServerRequest, res);
});
app.post('/groups/:id/members', async (req, res) => {
  await handlers.addGroupMember(req as ServerRequest, res);
});
app.delete('/groups/:id/members/:userId', async (req, res) => {
  await handlers.removeGroupMember(req as ServerRequest, res);
});
const outbox = () => mongoose.connection.db!.collection('governance_group_audit_outbox');

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    binary: { version: '8.2.1' },
    replSet: { count: 1 },
  });
  await mongoose.connect(replica.getUri());
  await models.Group.createCollection();
  await models.User.createCollection();
  await mongoose.connection.db!.createCollection('governance_group_audit_outbox');
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});
beforeEach(async () => {
  process.env = {
    ...environment,
    GOVERNANCE_PILOT_ENABLED: 'true',
    GOVERNANCE_AUDIT_URL: 'https://gateway.example/internal/group-audit',
    LIBRECHAT_SERVICE_CREDENTIAL: 'test-credential',
  };
  await runAsSystem(async () => {
    await models.Group.deleteMany({});
    await models.User.deleteMany({});
    await outbox().deleteMany({});
    actor = await models.User.create({
      email: 'admin@test.example',
      name: 'Admin',
      provider: 'openid',
      role: 'ADMIN',
      openidId: 'stable-subject',
      openidIssuer: 'https://identity.example',
    });
  });
});
afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

it.each(['true', 'TRUE', 'True', ' true '])(
  'audits CRUD and memberships with pilot mode %j',
  async (enabled) => {
    process.env.GOVERNANCE_PILOT_ENABLED = enabled;
    const sink = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const user = await runAsSystem(() =>
      models.User.create({ email: 'member@test.example', provider: 'openid', role: 'USER' }),
    );
    const created = await request(app)
      .post('/groups')
      .send({ name: 'Engineering', source: 'local' });
    expect(created.status).toBe(201);
    const id = created.body.group._id;
    expect((await request(app).patch(`/groups/${id}`).send({ name: 'Platform' })).status).toBe(200);
    expect(
      (await request(app).post(`/groups/${id}/members`).send({ userId: user._id.toString() }))
        .status,
    ).toBe(200);
    const groups = await runAsSystem(() => methods.getUserGroups(user._id));
    expect(groups.map((group) => group._id.toString())).toContain(id);
    expect((await request(app).delete(`/groups/${id}/members/${user._id}`)).status).toBe(200);
    expect(await runAsSystem(() => methods.getUserGroups(user._id))).toHaveLength(0);
    expect((await request(app).delete(`/groups/${id}`)).status).toBe(200);
    expect(await runAsSystem(() => methods.findGroupById(id))).toBeNull();
    const events = sink.mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(events.map((event) => event.action)).toEqual([
      'group.created',
      'group.updated',
      'membership.added',
      'membership.removed',
      'group.deleted',
    ]);
    expect(new Set(events.map((event) => event.mutation_id)).size).toBe(5);
    for (const event of events) {
      expect(event.actor).toEqual({
        issuer: 'https://identity.example',
        user_id: 'stable-subject',
      });
      expect(event.resource.id).toBe(id);
      expect(event.outcome).toBe('success');
      expect(event).not.toHaveProperty('email');
      expect(event).not.toHaveProperty('token');
      if (event.action.startsWith('membership.'))
        expect(event.resource.affected_user_id).toBe(user._id.toString());
    }
    expect(await outbox().countDocuments()).toBe(0);
  },
);

it.each(['TRUE', ' True '])('requires audit configuration with pilot mode %j', async (enabled) => {
  process.env.GOVERNANCE_PILOT_ENABLED = enabled;
  delete process.env.GOVERNANCE_AUDIT_URL;

  const response = await request(app).post('/groups').send({ name: 'Must be audited' });

  expect(response.status).toBe(503);
  expect(await runAsSystem(() => models.Group.countDocuments())).toBe(0);
  expect(await outbox().countDocuments()).toBe(0);
});

it('starts audit retries for normalized pilot mode and only starts one worker', () => {
  const interval = jest.spyOn(global, 'setInterval');
  process.env.GOVERNANCE_PILOT_ENABLED = 'false';
  startGovernanceGroupAuditDelivery();
  expect(interval).not.toHaveBeenCalled();

  process.env.GOVERNANCE_PILOT_ENABLED = ' TRUE ';
  try {
    startGovernanceGroupAuditDelivery();
    startGovernanceGroupAuditDelivery();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000);
  } finally {
    for (const result of interval.mock.results) {
      if (result.type === 'return') clearInterval(result.value);
    }
  }
});

it('keeps a durable event through an outage and reconnection, retrying the same ID', async () => {
  const sink = jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response(null, { status: 503 }));
  const response = await request(app).post('/groups').send({ name: 'Durable' });
  expect(response.status).toBe(201);
  expect(await runAsSystem(() => methods.findGroupById(response.body.group._id))).toBeTruthy();
  expect(await outbox().findOne()).toBeTruthy();
  await mongoose.disconnect();
  await mongoose.connect(replica.getUri());
  sink.mockImplementation(async () => new Response(null, { status: 204 }));
  await flushGovernanceGroupAudit();
  expect(await outbox().countDocuments()).toBe(0);
  expect(JSON.parse(sink.mock.calls[0][1]?.body as string)).toEqual(
    JSON.parse(sink.mock.calls[1][1]?.body as string),
  );
});

it('rolls back group writes if their durable audit cannot be persisted', async () => {
  await mongoose.connection.db!.command({
    collMod: 'governance_group_audit_outbox',
    validator: { $expr: { $literal: false } },
  });
  try {
    const response = await request(app).post('/groups').send({ name: 'Must roll back' });
    expect(response.status).toBe(500);
    expect(await runAsSystem(() => models.Group.countDocuments({ name: 'Must roll back' }))).toBe(
      0,
    );
    expect(await outbox().countDocuments()).toBe(0);
  } finally {
    await mongoose.connection.db!.command({
      collMod: 'governance_group_audit_outbox',
      validator: {},
    });
  }
});
