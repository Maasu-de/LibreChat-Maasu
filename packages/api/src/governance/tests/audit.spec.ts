import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels, createMethods, runAsSystem } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import { createAdminGroupsHandlers } from '../../admin/groups';
import {
  affectedSubjectRef,
  flushGovernanceGroupAudit,
  startGovernanceGroupAuditDelivery,
  replayGovernanceGroupAudit,
} from '../audit';

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
    PILOT_TENANT_ID: '00000000-0000-0000-0000-000000000001',
    USAGE_PSEUDONYMIZATION_SECRET: 'audit-test-secret',
  };
  delete process.env.GOVERNANCE_API_BASE_URL;
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
    expect(sink).not.toHaveBeenCalled();
    expect(await outbox().countDocuments()).toBe(5);
    await flushGovernanceGroupAudit();
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
      expect(Number.isFinite(Date.parse(event.occurred_at))).toBe(true);
      expect(event).not.toHaveProperty('email');
      expect(event).not.toHaveProperty('token');
      if (event.action.startsWith('membership.'))
        expect(event.resource.affected_subject_ref).toBe(affectedSubjectRef(user._id.toString()));
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

it.each([
  ['https://gateway.example/v1', 'https://gateway.example/api/v1/internal/group-audit'],
  ['https://gateway.example/v1/', 'https://gateway.example/api/v1/internal/group-audit'],
  [
    'https://gateway.example/prefix/v1/',
    'https://gateway.example/prefix/api/v1/internal/group-audit',
  ],
])('derives and delivers audit events from gateway base %s', async (base, endpoint) => {
  delete process.env.GOVERNANCE_AUDIT_URL;
  process.env.GOVERNANCE_API_BASE_URL = base;
  const sink = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

  const response = await request(app).post('/groups').send({ name: 'Audited by default' });

  expect(response.status).toBe(201);
  expect(sink).not.toHaveBeenCalled();
  await flushGovernanceGroupAudit();
  expect(sink).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: 'POST' }));
  expect(await outbox().countDocuments()).toBe(0);
});

it('prefers an explicit audit endpoint over the gateway base URL', async () => {
  process.env.GOVERNANCE_API_BASE_URL = 'https://gateway.example/v1';
  process.env.GOVERNANCE_AUDIT_URL = 'https://audit.example/custom-group-audit';
  const sink = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

  const response = await request(app).post('/groups').send({ name: 'Explicit audit endpoint' });

  expect(response.status).toBe(201);
  expect(sink).not.toHaveBeenCalled();
  await flushGovernanceGroupAudit();
  expect(sink).toHaveBeenCalledWith(
    process.env.GOVERNANCE_AUDIT_URL,
    expect.objectContaining({ method: 'POST' }),
  );
});

it.each([
  'not-a-url',
  'file:///v1',
  'https://user:password@gateway.example/v1',
  'https://gateway.example/v1?key=secret',
  'https://gateway.example/v1#fragment',
  'https://gateway.example/unrelated',
])('rejects an invalid audit base %s before mutating groups', async (base) => {
  delete process.env.GOVERNANCE_AUDIT_URL;
  process.env.GOVERNANCE_API_BASE_URL = base;

  const response = await request(app).post('/groups').send({ name: 'Must be audited' });

  expect(response.status).toBe(503);
  expect(await runAsSystem(() => models.Group.countDocuments())).toBe(0);
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
  await flushGovernanceGroupAudit();
  expect(await outbox().findOne()).toMatchObject({
    retryCount: 1,
    lastError: { kind: 'http', status: 503 },
  });
  await outbox().updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
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

it('backs off transient failures without blocking later events and preserves occurrence time', async () => {
  const sink = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ token: 'must not persist', error: 'private detail' }, { status: 503 }),
    )
    .mockResolvedValue(new Response(null, { status: 204 }));
  await request(app).post('/groups').send({ name: 'Retry' });
  await request(app).post('/groups').send({ name: 'Later' });
  const original = await outbox().find().sort({ createdAt: 1 }).next();
  const started = Date.now();
  await flushGovernanceGroupAudit();
  const pending = await outbox().findOne();
  expect(pending?.retryCount).toBe(1);
  expect(pending?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(started + 5000);
  expect(pending?.lastError).toEqual({ kind: 'http', status: 503 });
  expect(pending?.payload.occurred_at).toBe(original?.payload.occurred_at);
  expect(await outbox().countDocuments()).toBe(1);
  await flushGovernanceGroupAudit();
  expect(sink).toHaveBeenCalledTimes(2);
  await outbox().updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
  await flushGovernanceGroupAudit();
  expect(await outbox().countDocuments()).toBe(0);
});

it('quarantines rejected events, alerts, delivers later events and supports replay', async () => {
  const { logger } = await import('@librechat/data-schemas');
  const alert = jest.spyOn(logger, 'error');
  const sink = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(Response.json({ message: 'private details' }, { status: 422 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  await request(app).post('/groups').send({ name: 'Rejected' });
  await request(app).post('/groups').send({ name: 'Deliverable' });
  await flushGovernanceGroupAudit();
  const rejected = await outbox().findOne();
  expect(rejected?.status).toBe('quarantined');
  expect(rejected?.lastError).toEqual({ kind: 'http', status: 422 });
  expect(alert).toHaveBeenCalledWith(
    expect.stringContaining('Event quarantined'),
    expect.objectContaining({ status: 422 }),
  );
  expect(sink).toHaveBeenCalledTimes(2);
  await flushGovernanceGroupAudit();
  expect(sink).toHaveBeenCalledTimes(2);
  expect(await replayGovernanceGroupAudit([rejected!._id.toString()])).toBe(1);
  await flushGovernanceGroupAudit();
  expect(JSON.parse(sink.mock.calls[0][1]?.body as string)).toEqual(
    JSON.parse(sink.mock.calls[2][1]?.body as string),
  );
  expect(await outbox().countDocuments()).toBe(0);
});

it('recovers abandoned delivery leases and excludes active leases across workers', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await request(app).post('/groups').send({ name: 'Lease' });
  await outbox().updateMany({}, { $set: { leaseUntil: new Date(Date.now() + 60000) } });
  await flushGovernanceGroupAudit();
  expect(await outbox().countDocuments()).toBe(1);
  await outbox().updateMany({}, { $set: { leaseUntil: new Date(0) } });
  await flushGovernanceGroupAudit();
  expect(await outbox().countDocuments()).toBe(0);
});

it('preserves historical names and safe update details, suppressing no-op updates', async () => {
  const created = await request(app).post('/groups').send({ name: 'Engineering' });
  const id = created.body.group._id;
  await request(app)
    .patch(`/groups/${id}`)
    .send({ name: 'Platform', email: 'group@private.example' });
  await request(app).patch(`/groups/${id}`).send({ name: 'Platform' });
  await request(app).delete(`/groups/${id}`);
  const records = await outbox().find().sort({ createdAt: 1 }).toArray();
  expect(records.map((record) => record.payload.action)).toEqual([
    'group.created',
    'group.updated',
    'group.deleted',
  ]);
  expect(records[0].payload.resource.name).toBe('Engineering');
  expect(records[1].payload).toMatchObject({
    before: { name: 'Engineering', has_email: false },
    after: { name: 'Platform', has_email: true },
    changed_fields: ['name', 'email'],
  });
  expect(records[2].payload.resource.name).toBe('Platform');
  expect(JSON.stringify(records)).not.toContain('group@private.example');
});

it('uses the native request actor pseudonym for external members through every mutation', async () => {
  const user = await runAsSystem(() =>
    models.User.create({
      email: 'member@private.example',
      provider: 'openid',
      role: 'USER',
      idOnTheSource: 'external-member',
    }),
  );
  const created = await request(app)
    .post('/groups')
    .send({
      name: 'History',
      memberIds: [user._id.toString(), 'external-member'],
    });
  const id = created.body.group._id;
  expect(created.status).toBe(201);
  await request(app).post(`/groups/${id}/members`).send({ userId: user._id.toString() });
  await request(app).delete(`/groups/${id}/members/${user._id}`);
  await request(app).delete(`/groups/${id}/members/${user._id}`);
  await request(app).post(`/groups/${id}/members`).send({ userId: user._id.toString() });
  await request(app).delete(`/groups/${id}`);
  const records = await outbox().find().sort({ createdAt: 1 }).toArray();
  const memberships = records
    .map((record) => record.payload)
    .filter((event) => event.action.startsWith('membership.'));
  expect(memberships.map((event) => [event.action, event.cause])).toEqual([
    ['membership.added', undefined],
    ['membership.removed', 'member_removed'],
    ['membership.added', undefined],
    ['membership.removed', 'group_deleted'],
  ]);
  for (const event of memberships) {
    expect(event.resource.affected_subject_ref).toBe(affectedSubjectRef(user._id.toString()));
    expect(event.resource).not.toHaveProperty('affected_user_id');
  }
  expect(records.filter((record) => record.payload.action === 'group.deleted')).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain('external-member');
  expect(JSON.stringify(records)).not.toContain(user._id.toString());
});

it('records one removal per former member on group deletion, including unresolved external IDs', async () => {
  const created = await request(app)
    .post('/groups')
    .send({
      name: 'External',
      memberIds: ['external-one', 'external-two', 'external-one'],
    });
  expect(created.status).toBe(201);
  await outbox().deleteMany({});
  await request(app).delete(`/groups/${created.body.group._id}`);
  const records = await outbox().find().toArray();
  expect(records).toHaveLength(3);
  expect(records.filter((record) => record.payload.action === 'membership.removed')).toHaveLength(
    2,
  );
  for (const record of records.filter((record) => record.payload.action === 'membership.removed')) {
    expect(record.payload.cause).toBe('group_deleted');
    expect(record.payload.resource.affected_subject_ref).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
});

it('scopes pseudonyms to the tenant and matches the Gateway HMAC contract', () => {
  expect(affectedSubjectRef('member')).toBe(
    'sha256:72959ee6469da7bba8061983cef89d0aa6c049f5de5b2cefb143290cfa78fd80',
  );
  const first = affectedSubjectRef('member');
  process.env.PILOT_TENANT_ID = '00000000-0000-0000-0000-000000000002';
  expect(affectedSubjectRef('member')).not.toBe(first);
});

it('rolls back a populated deletion when its removal deliveries cannot be persisted', async () => {
  const created = await request(app)
    .post('/groups')
    .send({ name: 'Keep me', memberIds: ['external'] });
  const id = created.body.group._id;
  await outbox().deleteMany({});
  await mongoose.connection.db!.command({
    collMod: 'governance_group_audit_outbox',
    validator: { $expr: { $literal: false } },
  });
  try {
    expect((await request(app).delete(`/groups/${id}`)).status).toBe(500);
    const retained = await runAsSystem(() => methods.findGroupById(id));
    expect(retained?.memberIds).toEqual(['external']);
    expect(await outbox().countDocuments()).toBe(0);
  } finally {
    await mongoose.connection.db!.command({
      collMod: 'governance_group_audit_outbox',
      validator: {},
    });
  }
});

it('audits effective source-alias removal even when a native alias remains', async () => {
  const user = await runAsSystem(() =>
    models.User.create({
      email: 'alias@test.example',
      provider: 'openid',
      role: 'USER',
      idOnTheSource: 'alias-external',
    }),
  );
  const group = await runAsSystem(() =>
    methods.createGroup({
      name: 'Aliases',
      source: 'local',
      memberIds: [user._id.toString(), 'alias-external'],
    }),
  );
  expect(await runAsSystem(() => methods.findGroupsByMemberId(user._id))).toHaveLength(1);
  expect((await request(app).delete(`/groups/${group._id}/members/alias-external`)).status).toBe(
    200,
  );
  expect(await runAsSystem(() => methods.findGroupsByMemberId(user._id))).toHaveLength(0);
  const removal = await outbox().findOne();
  expect(removal?.payload).toMatchObject({ action: 'membership.removed', cause: 'member_removed' });
  expect(await outbox().countDocuments()).toBe(1);
  await request(app).delete(`/groups/${group._id}`);
  const records = await outbox().find().toArray();
  const removals = records.filter((record) => record.payload.action === 'membership.removed');
  expect(removals).toHaveLength(1);
  expect(removals[0].payload.resource.affected_subject_ref).toBe(
    affectedSubjectRef(user._id.toString()),
  );
});

it('audits adding the effective source alias when only a native alias was stored', async () => {
  const user = await runAsSystem(() =>
    models.User.create({
      email: 'source-alias@test.example',
      provider: 'openid',
      role: 'USER',
      idOnTheSource: 'effective-source',
    }),
  );
  const group = await runAsSystem(() =>
    methods.createGroup({
      name: 'Native alias',
      source: 'local',
      memberIds: [user._id.toString()],
    }),
  );
  expect(await runAsSystem(() => methods.findGroupsByMemberId(user._id))).toHaveLength(0);
  expect(
    (await request(app).post(`/groups/${group._id}/members`).send({ userId: user._id.toString() }))
      .status,
  ).toBe(200);
  expect(await runAsSystem(() => methods.findGroupsByMemberId(user._id))).toHaveLength(1);
  expect(
    (await request(app).post(`/groups/${group._id}/members`).send({ userId: user._id.toString() }))
      .status,
  ).toBe(200);
  const records = await outbox().find().toArray();
  expect(records).toHaveLength(1);
  expect(records[0].payload).toMatchObject({
    action: 'membership.added',
    resource: {
      affected_subject_ref: affectedSubjectRef(user._id.toString()),
    },
  });
});

it('emits one removal for a deleted effective member with multiple stored aliases', async () => {
  const user = await runAsSystem(() =>
    models.User.create({
      email: 'deleted-alias@test.example',
      provider: 'openid',
      role: 'USER',
      idOnTheSource: 'deleted-source',
    }),
  );
  const group = await runAsSystem(() =>
    methods.createGroup({
      name: 'Deleted aliases',
      source: 'local',
      memberIds: [user._id.toString(), 'deleted-source'],
    }),
  );
  expect(await runAsSystem(() => methods.findGroupsByMemberId(user._id))).toHaveLength(1);
  expect((await request(app).delete(`/groups/${group._id}`)).status).toBe(200);
  const records = await outbox().find().toArray();
  expect(records).toHaveLength(2);
  const removal = records.find((record) => record.payload.action === 'membership.removed');
  expect(removal?.payload).toMatchObject({
    cause: 'group_deleted',
    resource: {
      affected_subject_ref: affectedSubjectRef(user._id.toString()),
    },
  });
});

it.each(['PILOT_TENANT_ID', 'USAGE_PSEUDONYMIZATION_SECRET'])(
  'rejects pilot group writes when %s is missing',
  async (setting) => {
    delete process.env[setting];
    expect((await request(app).post('/groups').send({ name: 'Must not persist' })).status).toBe(
      503,
    );
    expect(await runAsSystem(() => models.Group.countDocuments())).toBe(0);
    expect(await outbox().countDocuments()).toBe(0);
  },
);

it('canonicalizes uppercase tenant UUIDs like the Gateway', () => {
  process.env.PILOT_TENANT_ID = 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF';
  expect(affectedSubjectRef('member')).toBe(
    'sha256:5a50950938c9fb4dcb20daf972388944bb49cffd082ce37a6977d5ed4e88dd58',
  );
});

describe.each(['true', 'false'])('raw member validation with pilot mode %s', (enabled) => {
  it.each([
    { label: 'an empty string', id: '' },
    { label: 'a whitespace-only string', id: ' \t\n' },
    { label: 'a string longer than 256 characters', id: 'x'.repeat(257) },
    { label: 'a number', id: 42 },
    { label: 'a boolean', id: false },
    { label: 'null', id: null },
    { label: 'an object', id: { member: 'external' } },
    { label: 'an array', id: ['external'] },
  ])('rejects $label before creating a group or audit delivery', async ({ id }) => {
    process.env.GOVERNANCE_PILOT_ENABLED = enabled;
    const response = await request(app)
      .post('/groups')
      .send({
        name: 'Invalid members',
        memberIds: [actor._id.toString(), id],
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(
      'memberIds must contain non-empty strings of at most 256 characters',
    );
    expect(await runAsSystem(() => models.Group.countDocuments())).toBe(0);
    expect(await outbox().countDocuments()).toBe(0);
  });
});

it('accepts external member identifiers at the 1- and 256-character boundaries', async () => {
  const memberIds = ['a', 'x'.repeat(256)];
  const response = await request(app).post('/groups').send({ name: 'Valid boundaries', memberIds });
  expect(response.status).toBe(201);
  const group = await runAsSystem(() => methods.findGroupById(response.body.group._id));
  expect(group?.memberIds).toEqual(memberIds);
  const records = await outbox().find().toArray();
  expect(records.filter((record) => record.payload.action === 'membership.added')).toHaveLength(2);
});

it.each([
  {
    scope: 'issuers',
    issuers: ['https://issuer-one.example', 'https://issuer-two.example'],
    tenants: ['tenant-a', 'tenant-a'],
  },
  {
    scope: 'tenants',
    issuers: ['https://issuer.example', 'https://issuer.example'],
    tenants: ['tenant-a', 'tenant-b'],
  },
])(
  'audits every effective member sharing a source alias across $scope',
  async ({ issuers, tenants }) => {
    const sharedAlias = 'review-shared-source';
    const users = await runAsSystem(() =>
      models.User.create(
        issuers.map((issuer, index) => ({
          email: `shared-${index}@test.example`,
          provider: 'openid',
          role: 'USER',
          openidId: 'shared-subject',
          openidIssuer: issuer,
          tenantId: tenants[index],
          idOnTheSource: sharedAlias,
        })),
      ),
    );
    const references = users.map((user) => affectedSubjectRef(user._id.toString())).sort();
    expect(new Set(references).size).toBe(2);
    const created = await request(app)
      .post('/groups')
      .send({ name: 'Shared members', memberIds: [sharedAlias] });
    expect(created.status).toBe(201);
    const id = created.body.group._id;
    expect(created.body.group.memberIds).toEqual([sharedAlias]);
    for (const user of users) {
      const groups = await runAsSystem(() => methods.findGroupsByMemberId(user._id));
      expect(groups.map((group) => group._id.toString())).toContain(id);
    }
    let records = await outbox().find().toArray();
    expect(records).toHaveLength(3);
    expect(
      records
        .filter((record) => record.payload.action === 'membership.added')
        .map((record) => record.payload.resource.affected_subject_ref)
        .sort(),
    ).toEqual(references);

    expect(
      (await request(app).post(`/groups/${id}/members`).send({ userId: users[0]._id.toString() }))
        .status,
    ).toBe(200);
    expect(await outbox().countDocuments()).toBe(3);
    expect((await request(app).delete(`/groups/${id}/members/${sharedAlias}`)).status).toBe(200);
    for (const user of users) {
      expect(await runAsSystem(() => methods.findGroupsByMemberId(user._id))).toHaveLength(0);
    }
    records = await outbox().find().toArray();
    expect(records).toHaveLength(5);
    const individualRemovals = records.filter(
      (record) => record.payload.action === 'membership.removed',
    );
    expect(individualRemovals.map((record) => record.payload.cause)).toEqual([
      'member_removed',
      'member_removed',
    ]);
    expect(
      individualRemovals.map((record) => record.payload.resource.affected_subject_ref).sort(),
    ).toEqual(references);
    expect((await request(app).delete(`/groups/${id}/members/${sharedAlias}`)).status).toBe(200);
    expect(await outbox().countDocuments()).toBe(5);

    expect(
      (await request(app).post(`/groups/${id}/members`).send({ userId: users[0]._id.toString() }))
        .status,
    ).toBe(200);
    expect(await outbox().countDocuments()).toBe(7);
    expect(
      (await request(app).post(`/groups/${id}/members`).send({ userId: users[1]._id.toString() }))
        .status,
    ).toBe(200);
    expect(await outbox().countDocuments()).toBe(7);
    for (const user of users) {
      const groups = await runAsSystem(() => methods.findGroupsByMemberId(user._id));
      expect(groups.map((group) => group._id.toString())).toContain(id);
    }
    expect((await request(app).delete(`/groups/${id}`)).status).toBe(200);
    records = await outbox().find().toArray();
    expect(records).toHaveLength(10);
    expect(records.filter((record) => record.payload.action === 'group.deleted')).toHaveLength(1);
    const deletionRemovals = records.filter((record) => record.payload.cause === 'group_deleted');
    expect(
      deletionRemovals.map((record) => record.payload.resource.affected_subject_ref).sort(),
    ).toEqual(references);
    for (const user of users) expect(JSON.stringify(records)).not.toContain(user._id.toString());
    expect(JSON.stringify(records)).not.toContain(sharedAlias);
  },
);
