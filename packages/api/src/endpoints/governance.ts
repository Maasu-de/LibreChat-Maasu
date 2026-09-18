import { createHmac } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { IGroup, IUser } from '@librechat/data-schemas';
import type {
  FinanceUsageBreakdownRow,
  FinanceUsageDashboard,
  FinanceUsageQueryParams,
  GovernanceConnectionResponse,
} from 'librechat-data-provider';
import type { Request, Response } from 'express';

const GOVERNANCE_HEALTH_TIMEOUT_MS = 5_000;
const GOVERNANCE_USAGE_TIMEOUT_MS = 10_000;

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

type UsageUser = Pick<IUser, '_id'> & Partial<Pick<IUser, 'name' | 'username' | 'email'>>;
type UsageGroup = Pick<IGroup, '_id' | 'name' | 'idOnTheSource'>;

export interface GovernanceUsageDeps {
  /** Lists the users whose usage pseudonyms can be resolved to display names */
  findUsers: (
    criteria: Record<string, unknown>,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<UsageUser[]>;
  /** Finds groups whose `_id` or `idOnTheSource` matches one of the given IDs */
  findGroups: (ids: string[]) => Promise<UsageGroup[]>;
}

interface GovernanceHealthResponse {
  status: string;
}

const getGovernanceHealthUrl = (): string => {
  return getGovernanceUrl('/healthz');
};

const getGovernanceUsageUrl = (params: FinanceUsageQueryParams): string => {
  const url = new URL(getGovernanceUrl('/api/v1/finance/usage'));
  if (params.start_date != null) {
    url.searchParams.set('start_date', params.start_date);
  }
  if (params.end_date != null) {
    url.searchParams.set('end_date', params.end_date);
  }
  return url.toString();
};

const getGovernanceUrl = (path: string): string => {
  const baseUrl = process.env.GOVERNANCE_API_BASE_URL;
  if (!baseUrl) {
    throw new Error('GOVERNANCE_API_BASE_URL is not configured');
  }

  return new URL(path, baseUrl).toString();
};

const getServiceCredential = (): string => {
  const serviceCredential = process.env.LIBRECHAT_SERVICE_CREDENTIAL;
  if (!serviceCredential) {
    throw new Error('LIBRECHAT_SERVICE_CREDENTIAL is not configured');
  }
  return serviceCredential;
};

const readDateQuery = (value: unknown): string | undefined => {
  if (value == null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return readDateQuery(value[0]);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Invalid date query');
  }
  return value;
};

export const testGovernanceConnection = async (_req: Request, res: Response): Promise<void> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOVERNANCE_HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(getGovernanceHealthUrl(), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Governance health check returned HTTP ${response.status}`);
    }

    const health = (await response.json()) as GovernanceHealthResponse;
    if (health.status !== 'healthy') {
      throw new Error('Governance health check returned an unexpected response');
    }

    const result: GovernanceConnectionResponse = { status: 'connected' };
    res.status(200).json(result);
  } catch (error) {
    logger.error('[testGovernanceConnection] Governance backend is unavailable:', error);
    res.status(503).json({ status: 'unavailable' });
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Mirrors the gateway's `pseudonymize_user_id`: HMAC-SHA256 over `<tenant_id>:<user_id>`.
 * Chat requests forward the Mongo user `_id` as the user ID.
 */
const pseudonymizeUserId = (secret: string, tenantId: string, userId: string): string => {
  const digest = createHmac('sha256', secret).update(`${tenantId}:${userId}`).digest('hex');
  return `sha256:${digest}`;
};

const shortenPseudonym = (pseudonym: string): string => {
  const [prefix, digest] = pseudonym.split(':');
  if (prefix !== 'sha256' || !digest || digest.length <= 12) {
    return pseudonym;
  }
  return `${prefix}:${digest.slice(0, 12)}…`;
};

const getUserDisplayName = (user: UsageUser): string | undefined =>
  user.name?.trim() || user.username?.trim() || user.email?.trim() || undefined;

const resolveUserLabels = async (
  rows: FinanceUsageBreakdownRow[],
  deps: GovernanceUsageDeps,
): Promise<FinanceUsageBreakdownRow[]> => {
  const secret = process.env.USAGE_PSEUDONYMIZATION_SECRET;
  const tenantId = process.env.PILOT_TENANT_ID;
  if (!secret || !tenantId || rows.length === 0) {
    return rows.map((row) => ({ ...row, label: shortenPseudonym(row.label) }));
  }

  const users = await deps.findUsers({}, '_id name username email');
  const namesByPseudonym = new Map<string, string>();
  for (const user of users) {
    const displayName = getUserDisplayName(user);
    if (displayName) {
      namesByPseudonym.set(pseudonymizeUserId(secret, tenantId, String(user._id)), displayName);
    }
  }

  return rows.map((row) => ({
    ...row,
    label: namesByPseudonym.get(row.key) ?? shortenPseudonym(row.label),
  }));
};

const resolveTeamLabels = async (
  rows: FinanceUsageBreakdownRow[],
  deps: GovernanceUsageDeps,
): Promise<FinanceUsageBreakdownRow[]> => {
  if (rows.length === 0) {
    return rows;
  }

  const groups = await deps.findGroups(rows.map((row) => row.key));
  const namesById = new Map<string, string>();
  for (const group of groups) {
    namesById.set(String(group._id), group.name);
    if (group.idOnTheSource) {
      namesById.set(group.idOnTheSource, group.name);
    }
  }

  return rows.map((row) => ({ ...row, label: namesById.get(row.key) ?? row.label }));
};

/** Replaces pseudonymous user and raw group IDs with LibreChat display names. */
export const resolveUsageLabels = async (
  usage: FinanceUsageDashboard,
  deps: GovernanceUsageDeps,
): Promise<FinanceUsageDashboard> => {
  try {
    const [byUser, byTeam] = await Promise.all([
      resolveUserLabels(usage.by_user, deps),
      resolveTeamLabels(usage.by_team, deps),
    ]);
    return { ...usage, by_user: byUser, by_team: byTeam };
  } catch (error) {
    logger.error('[resolveUsageLabels] Failed to resolve usage labels:', error);
    return usage;
  }
};

export const createGetGovernanceUsage =
  (deps: GovernanceUsageDeps) =>
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let params: FinanceUsageQueryParams;
    try {
      params = {
        start_date: readDateQuery(req.query.start_date),
        end_date: readDateQuery(req.query.end_date),
      };
    } catch {
      res.status(400).json({ message: 'Invalid date filter' });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GOVERNANCE_USAGE_TIMEOUT_MS);

    try {
      const response = await fetch(getGovernanceUsageUrl(params), {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${getServiceCredential()}`,
          'X-LibreChat-User-ID': String(req.user?.id ?? ''),
          /** Route is guarded by FINANCE READ permission before reaching this handler */
          'X-LibreChat-Finance-Authorized': 'true',
        },
      });

      if (!response.ok) {
        const status = response.status === 400 ? 400 : 503;
        res.status(status).json({ message: 'Governance usage dashboard is unavailable' });
        return;
      }

      const usage = (await response.json()) as FinanceUsageDashboard;
      res.status(200).json(await resolveUsageLabels(usage, deps));
    } catch (error) {
      logger.error('[getGovernanceUsage] Governance backend is unavailable:', error);
      res.status(503).json({ message: 'Governance usage dashboard is unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  };
