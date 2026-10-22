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
  payload: {
    mutation_id: string;
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

export function isGovernanceGroupAuditConfigured(req: ServerRequest): boolean {
  return (
    !isGovernancePilotEnabled() ||
    Boolean(
      process.env.GOVERNANCE_AUDIT_URL &&
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
        const deliveries: GroupAuditDelivery[] = events.map((event) => {
          const id = randomUUID();
          return {
            _id: id,
            createdAt: new Date(),
            payload: {
              mutation_id: id,
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
    await flushGovernanceGroupAudit();
    return result;
  } finally {
    await session.endSession();
  }
}

let delivery: Promise<void> | undefined;

async function deliverPendingAudit(): Promise<void> {
  const endpoint = process.env.GOVERNANCE_AUDIT_URL;
  const credential = process.env.LIBRECHAT_SERVICE_CREDENTIAL;
  if (!endpoint || !credential || mongoose.connection.readyState !== 1) return;
  const records = await outbox().find().sort({ createdAt: 1, _id: 1 }).limit(100).toArray();
  for (const record of records) {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(record.payload),
    });
    if (!response.ok) throw new Error('Governance audit delivery pending');
    await outbox().deleteOne({ _id: record._id });
  }
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
