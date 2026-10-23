import { timingSafeEqual } from 'node:crypto';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { IGroup } from '@librechat/data-schemas';

const PAGE_SIZE = 200;

type GroupRef = Pick<IGroup, '_id' | 'name'>;

export interface GovernanceGroupsDeps {
  listGroups: (filter: { limit: number; offset: number }) => Promise<GroupRef[]>;
}

export interface UserGroupIdsDeps {
  getUserGroups: (
    userId: string,
    projection?: Record<string, 0 | 1>,
  ) => Promise<Pick<IGroup, '_id'>[]>;
}

function readBearer(header: string | undefined): string {
  const match = header?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? '';
}

function matchesCredential(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/** Authorizes the Governance Gateway itself; end-user OIDC tokens never cross this boundary. */
export function requireGovernanceGatewayService(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.GOVERNANCE_GATEWAY_SERVICE_CREDENTIAL?.trim() ?? '';
  if (!expected) {
    logger.error('[GovernanceGroups] Gateway service credential is not configured');
    res.status(503).json({ message: 'Group lookup is not configured.' });
    return;
  }

  if (!matchesCredential(readBearer(req.headers.authorization), expected)) {
    logger.warn('[GovernanceGroups] Rejected request with an invalid service credential');
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  next();
}

async function listAllGroups(listGroups: GovernanceGroupsDeps['listGroups']): Promise<GroupRef[]> {
  const all: GroupRef[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await listGroups({ limit: PAGE_SIZE, offset });
    all.push(...page);
    if (page.length < PAGE_SIZE) {
      return all;
    }
  }
}

export const createListGovernanceGroups =
  ({ listGroups }: GovernanceGroupsDeps) =>
  async (_req: Request, res: Response): Promise<void> => {
    try {
      /** The Governance Gateway manages the whole deployment, so this read is cross-tenant. */
      const groups = await runAsSystem(() => listAllGroups(listGroups));
      res.status(200).json({
        groups: groups.map((group) => ({ id: group._id.toString(), name: group.name })),
      });
    } catch (error) {
      logger.error('[GovernanceGroups] Group lookup failed', {
        message: (error as Error)?.message,
      });
      res.status(500).json({ message: 'Unable to list groups.' });
    }
  };

/** IDs of the LibreChat groups a user belongs to, as sent to the governance backend. */
export const createGetUserGroupIds =
  ({ getUserGroups }: UserGroupIdsDeps) =>
  async (userId: string): Promise<string[]> => {
    const groups = await getUserGroups(userId, { _id: 1 });
    return groups.map((group) => group._id.toString());
  };
