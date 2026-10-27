import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { ClientSession } from 'mongoose';
import type { IGroup } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import { isGovernancePilotEnabled } from './mode';

export type GroupMutationAction =
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'
  | 'membership.added'
  | 'membership.removed';

interface GroupAuditDelivery {
  _id: string;
  createdAt: Date;
  status?: 'pending' | 'quarantined';
  retryCount?: number;
  nextAttemptAt?: Date;
  leaseUntil?: Date;
  leaseId?: string;
  lastError?: { kind: 'http' | 'network'; status?: number };
  quarantinedAt?: Date;
  payload: {
    mutation_id: string;
    occurred_at: string;
    action: GroupMutationAction;
    outcome: 'success';
    actor: { issuer: string; user_id: string };
    resource: { type: 'group'; id: string; affected_user_id?: string };
  };
}

function outbox() {
  if (!mongoose.connection.db) throw new Error('Governance audit database unavailable');
  return mongoose.connection.db.collection<GroupAuditDelivery>('governance_group_audit_outbox');
}

function getGovernanceGroupAuditUrl(): string | undefined {
  const explicit = process.env.GOVERNANCE_AUDIT_URL?.trim();
  const configured = explicit || process.env.GOVERNANCE_API_BASE_URL?.trim();
  if (!configured) return;
  try {
    const url = new URL(configured);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    if (!explicit) {
      const path = url.pathname.replace(/\/+$/, '');
      if (!path.endsWith('/v1')) return;
      url.pathname = path.replace(/\/v1$/, '/api/v1/internal/group-audit');
    }
    return url.href;
  } catch {
    return;
  }
}

export function isGovernanceGroupAuditConfigured(req: ServerRequest): boolean {
  return (
    !isGovernancePilotEnabled() ||
    Boolean(
      getGovernanceGroupAuditUrl() &&
        process.env.LIBRECHAT_SERVICE_CREDENTIAL &&
        req.user?.openidIssuer &&
        req.user.openidId,
    )
  );
}

export function groupSessionArgs(session?: ClientSession): [] | [ClientSession] {
  return session ? [session] : [];
}

/** Commit the existing group mutation and its audit delivery atomically in MongoDB. */
export async function mutateGovernanceGroup(
  req: ServerRequest,
  action: GroupMutationAction,
  operation: (session?: ClientSession) => Promise<IGroup | null>,
  affectedUserIds: string[] = [],
): Promise<IGroup | null> {
  if (!isGovernancePilotEnabled()) return operation();
  const actor = req.user;
  if (!isGovernanceGroupAuditConfigured(req) || !actor?.openidIssuer || !actor.openidId) {
    throw new Error('Governance group audit is not configured');
  }
  if (affectedUserIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256)) {
    throw new Error('Invalid affected user identifier');
  }
  const identity = { issuer: actor.openidIssuer, user_id: actor.openidId };
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(
      async () => {
        const group = await operation(session);
        if (!group) return null;
        const events: { action: GroupMutationAction; userId?: string }[] =
          action === 'group.created'
            ? [
                { action },
                ...affectedUserIds.map((userId) => ({
                  action: 'membership.added' as const,
                  userId,
                })),
              ]
            : [{ action, userId: affectedUserIds[0] }];
        const occurredAt = new Date();
        const deliveries: GroupAuditDelivery[] = events.map((event) => {
          const id = randomUUID();
          return {
            _id: id,
            createdAt: occurredAt,
            status: 'pending',
            retryCount: 0,
            nextAttemptAt: occurredAt,
            payload: {
              mutation_id: id,
              occurred_at: occurredAt.toISOString(),
              action: event.action,
              outcome: 'success',
              actor: identity,
              resource: {
                type: 'group',
                id: group._id.toString(),
                ...(event.userId ? { affected_user_id: event.userId } : {}),
              },
            },
          };
        });
        await outbox().insertMany(deliveries, { session });
        return group;
      },
      { writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

let delivery: Promise<void> | undefined;

const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const LEASE_MS = 30000;
let lastQuarantineAlert = 0;

async function deliverPendingAudit(): Promise<void> {
  const endpoint = getGovernanceGroupAuditUrl();
  const credential = process.env.LIBRECHAT_SERVICE_CREDENTIAL;
  if (!endpoint || !credential || mongoose.connection.readyState !== 1) return;
  for (let i = 0; i < 100; i++) {
    const now = new Date();
    const leaseId = randomUUID();
    const record = await outbox().findOneAndUpdate(
      {
        status: { $ne: 'quarantined' },
        $and: [
          { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
          { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
        ],
      },
      { $set: { leaseId, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { sort: { createdAt: 1, _id: 1 }, returnDocument: 'after' },
    );
    if (!record) break;
    const filter = { _id: record._id, leaseId };
    let status: number | undefined;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...record.payload,
          occurred_at: record.payload.occurred_at ?? record.createdAt.toISOString(),
        }),
      });
      status = response.status;
      if (response.ok) {
        await outbox().deleteOne(filter);
        continue;
      }
    } catch {
      // Store only a fixed error category; provider bodies and credentials stay out of the outbox.
    }
    const retryCount = (record.retryCount ?? 0) + 1;
    const rejected =
      status != null && status >= 400 && status < 500 && ![408, 425, 429].includes(status);
    const lastError: NonNullable<GroupAuditDelivery['lastError']> =
      status == null ? { kind: 'network' } : { kind: 'http', status };
    await outbox().updateOne(filter, {
      $set: {
        status: rejected ? 'quarantined' : 'pending',
        retryCount,
        lastError,
        ...(rejected
          ? { quarantinedAt: new Date() }
          : {
              nextAttemptAt: new Date(
                Date.now() +
                  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(retryCount - 1, 16)),
              ),
            }),
      },
      $unset: { leaseUntil: '', leaseId: '' },
    });
    if (rejected)
      logger.error('[Governance audit] Event quarantined; operator replay required', {
        mutationId: record._id,
        retryCount,
        status,
      });
  }
  if (Date.now() - lastQuarantineAlert >= 60000) {
    const quarantined = await outbox().countDocuments({ status: 'quarantined' });
    if (quarantined)
      logger.error('[Governance audit] Quarantined events require replay', { count: quarantined });
    lastQuarantineAlert = Date.now();
  }
}

/** Operator-only recovery after correcting the rejection; preserves identity and chronology. */
export async function replayGovernanceGroupAudit(mutationIds: string[]): Promise<number> {
  if (!mutationIds.length) throw new Error('Specify quarantined mutation IDs to replay');
  const result = await outbox().updateMany(
    { _id: { $in: mutationIds }, status: 'quarantined' },
    {
      $set: { status: 'pending', retryCount: 0, nextAttemptAt: new Date() },
      $unset: { quarantinedAt: '', lastError: '', leaseUntil: '', leaseId: '' },
    },
  );
  return result.modifiedCount;
}

/** Retain pending events on network failures; duplicate deliveries are deduplicated by the Gateway. */
export function flushGovernanceGroupAudit(): Promise<void> {
  if (delivery) return delivery;
  delivery = deliverPendingAudit()
    .catch(() => {
      logger.warn('[Governance audit] Delivery pending; durable events will be retried');
    })
    .finally(() => {
      delivery = undefined;
    });
  return delivery;
}

let worker: ReturnType<typeof setInterval> | undefined;
export function startGovernanceGroupAuditDelivery(): void {
  if (worker || !isGovernancePilotEnabled()) return;
  worker = setInterval(() => {
    void flushGovernanceGroupAudit();
  }, 5000);
  worker.unref();
}
