import mongoose from 'mongoose';
import { getTenantId } from '@librechat/data-schemas';
import type { ClientSession } from 'mongoose';

interface Authorization {
  _id: string;
  generation: number;
  authorized?: boolean;
  binding?: string;
  publications?: number;
}

export class GovernanceMCPOAuthStaleError extends Error {
  constructor() {
    super('MCP OAuth authorization is no longer current');
    this.name = 'GovernanceMCPOAuthStaleError';
  }
}

function authorizations() {
  if (!mongoose.connection.db) throw new Error('MCP OAuth authorization storage unavailable');
  return mongoose.connection.db.collection<Authorization>('governance_mcp_oauth_authorizations');
}

function authorizationId(userId: string, connectionId: string): string {
  return JSON.stringify([getTenantId() ?? null, userId, connectionId]);
}

export async function getGovernanceMCPOAuthGeneration(
  userId: string,
  connectionId: string,
): Promise<number> {
  const _id = authorizationId(userId, connectionId);
  try {
    const authorization = await authorizations().findOneAndUpdate(
      { _id },
      { $setOnInsert: { generation: 0 } },
      { upsert: true, returnDocument: 'after' },
    );
    if (authorization) return authorization.generation;
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
    const authorization = await authorizations().findOne({ _id });
    if (authorization) return authorization.generation;
  }
  throw new Error('MCP OAuth authorization storage unavailable');
}

export async function isGovernanceMCPOAuthAuthorized(
  userId: string,
  connectionId: string,
  binding?: string,
  generation?: number,
): Promise<boolean> {
  const authorization = await authorizations().findOne({
    _id: authorizationId(userId, connectionId),
  });
  return (
    authorization?.authorized === true &&
    authorization.binding === binding &&
    (generation === undefined || authorization.generation === generation)
  );
}

export async function getGovernanceMCPOAuthAuthorizedGeneration(
  userId: string,
  connectionId: string,
  binding: string,
): Promise<number> {
  const authorization = await authorizations().findOne({
    _id: authorizationId(userId, connectionId),
    authorized: true,
    binding,
  });
  if (!authorization) throw new GovernanceMCPOAuthStaleError();
  return authorization.generation;
}

/** Serialize authorization commits and revocation across backend processes. */
export async function claimGovernanceMCPOAuthGeneration(
  userId: string,
  connectionId: string,
  generation: number,
  session: ClientSession,
  binding?: string,
): Promise<void> {
  const result = await authorizations().updateOne(
    { _id: authorizationId(userId, connectionId), generation },
    {
      $inc: { generation: 1 },
      $set: { authorized: true, ...(binding ? { binding } : {}) },
      ...(!binding ? { $unset: { binding: '' } } : {}),
    },
    { session },
  );
  if (result.modifiedCount !== 1) throw new GovernanceMCPOAuthStaleError();
}

export async function advanceGovernanceMCPOAuthGeneration(
  userId: string,
  connectionId: string,
  session: ClientSession,
): Promise<void> {
  const result = await authorizations().updateOne(
    { _id: authorizationId(userId, connectionId) },
    { $inc: { generation: 1 }, $set: { authorized: false } },
    { session },
  );
  if (result.modifiedCount !== 1) throw new Error('MCP OAuth authorization storage unavailable');
}

/** Serialize token writes and flow completion with revocation; never perform remote work here. */
export async function withGovernanceMCPOAuthGeneration(
  userId: string,
  connectionId: string,
  generation: number,
  operation: (session: ClientSession) => Promise<void>,
  binding?: string,
): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(
      async () => {
        const result = await authorizations().updateOne(
          {
            _id: authorizationId(userId, connectionId),
            generation,
            ...(binding && { authorized: true, binding }),
          },
          { $inc: { publications: 1 } },
          { session },
        );
        if (result.modifiedCount !== 1) throw new GovernanceMCPOAuthStaleError();
        await operation(session);
      },
      { writeConcern: { w: 'majority' } },
    );
  } finally {
    await session.endSession();
  }
}
