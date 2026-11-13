import { createHash } from 'node:crypto';
import { SystemCapabilities } from '@librechat/data-schemas';
import type { SystemCapability } from '@librechat/data-schemas';
import type { CapabilityUser, HasCapabilityFn } from '../middleware/capabilities';
import type { ParsedServerConfig } from '~/mcp/types';
import { GOVERNANCE_ADMIN_ROLE } from '../auth/administrator';
import { isGovernancePilotEnabled } from './mode';

export function governanceGroupCapabilities(): SystemCapability[] {
  return [
    SystemCapabilities.ACCESS_ADMIN,
    SystemCapabilities.READ_GROUPS,
    SystemCapabilities.MANAGE_GROUPS,
  ];
}

export async function getGovernanceGroupCapabilities(
  user: CapabilityUser,
  hasCapability: HasCapabilityFn,
): Promise<SystemCapability[]> {
  const capabilities = governanceGroupCapabilities();
  const allowed = await Promise.all(
    capabilities.map((capability) => hasCapability(user, capability)),
  );
  return capabilities.filter((_capability, index) => allowed[index]);
}

export function isGovernanceAdministrator(role?: string | null): boolean {
  return role === GOVERNANCE_ADMIN_ROLE;
}

/** Includes only the session and lookup APIs required by the group editor. */
export function isGovernanceGroupApi(method: string, originalUrl: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(originalUrl.split('?')[0]).replace(/\/+$/, '').toLowerCase();
  } catch {
    return false;
  }
  if (
    (method === 'GET' && /^\/api\/admin\/oauth\/openid(?:\/callback)?$/.test(path)) ||
    (method === 'POST' && ['/api/admin/oauth/exchange', '/api/admin/oauth/refresh'].includes(path))
  )
    return true;
  if (/^\/api\/admin\/groups(?:\/|$)/.test(path)) return true;
  return method === 'GET' && path === '/api/admin/verify';
}

/** Keep personal grants scoped to one managed connection and its authorization target. */
export function getGovernanceMCPOAuthBinding(config?: ParsedServerConfig): string | undefined {
  if (!isGovernancePilotEnabled() || !config?.dbId || !config.url) return;
  const oauth = Object.entries(config.oauth ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash('sha256')
    .update(JSON.stringify([config.dbId, config.type, new URL(config.url).href, oauth]))
    .digest('hex');
}
