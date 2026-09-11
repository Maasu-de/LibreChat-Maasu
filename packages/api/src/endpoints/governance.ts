import { logger } from '@librechat/data-schemas';
import type { GovernanceConnectionResponse } from 'librechat-data-provider';
import type { Request, Response } from 'express';

const GOVERNANCE_HEALTH_TIMEOUT_MS = 5_000;

interface GovernanceHealthResponse {
  status: string;
}

const getGovernanceHealthUrl = (): string => {
  const baseUrl = process.env.GOVERNANCE_API_BASE_URL;
  if (!baseUrl) {
    throw new Error('GOVERNANCE_API_BASE_URL is not configured');
  }

  return new URL('/healthz', baseUrl).toString();
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
