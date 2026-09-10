import { logger } from '@librechat/data-schemas';
import type {
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

export const getGovernanceUsage = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
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
      },
    });

    if (!response.ok) {
      const status = response.status === 400 ? 400 : 503;
      res.status(status).json({ message: 'Governance usage dashboard is unavailable' });
      return;
    }

    const usage = (await response.json()) as FinanceUsageDashboard;
    res.status(200).json(usage);
  } catch (error) {
    logger.error('[getGovernanceUsage] Governance backend is unavailable:', error);
    res.status(503).json({ message: 'Governance usage dashboard is unavailable' });
  } finally {
    clearTimeout(timeout);
  }
};
