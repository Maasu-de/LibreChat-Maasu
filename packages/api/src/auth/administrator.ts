import get from 'lodash/get';
import { SystemRoles } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { RefreshTokenset } from './refresh';
import { isGovernancePilotEnabled } from '../governance/mode';

export const GOVERNANCE_ADMIN_ROLE: SystemRoles.GOVERNANCE_ADMIN = SystemRoles.GOVERNANCE_ADMIN;

export function assertOidcAdministratorConfigured(): void {
  if (!isGovernancePilotEnabled()) return;
  if (!process.env.OPENID_ADMIN_ROLE?.trim()) {
    throw new Error('Governed mode requires OPENID_ADMIN_ROLE');
  }
  if (!process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH?.trim()) {
    throw new Error('Governed mode requires OPENID_ADMIN_ROLE_PARAMETER_PATH');
  }
}

export function hasOidcAdministratorClaim(claims: object): boolean {
  const expected = process.env.OPENID_ADMIN_ROLE?.trim();
  const path = process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH?.trim();
  if (!expected || !path) return false;
  const value = get(claims, path);
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

/** Applies only to validated ID-token claims supplied by the OIDC client. */
export function applyGovernanceAdministratorRole(user: IUser, claims: object): boolean {
  assertOidcAdministratorConfigured();
  if (!isGovernancePilotEnabled()) return false;
  const entitled = hasOidcAdministratorClaim(claims);
  if (entitled) {
    user.role = GOVERNANCE_ADMIN_ROLE;
  } else if (user.role === SystemRoles.ADMIN || user.role === GOVERNANCE_ADMIN_ROLE) {
    user.role = SystemRoles.USER;
  }
  return entitled;
}

export async function syncOidcAdministrator(
  user: IUser,
  tokenset: RefreshTokenset,
  updateUser: (id: string, data: Partial<IUser>) => Promise<IUser | null>,
): Promise<void> {
  if (!isGovernancePilotEnabled()) return;
  const previousRole = user.role;
  applyGovernanceAdministratorRole(user, tokenset.claims());
  if (user.role === previousRole) return;
  const updated = await updateUser(user._id.toString(), { role: user.role });
  if (!updated) throw new Error('Unable to synchronize OIDC administrator');
}

export function requiresOidcEntitlementRefresh(user: Pick<IUser, 'provider'>): boolean {
  return isGovernancePilotEnabled() && user.provider === 'openid';
}

export function hasStaleGovernanceAdministratorRole(
  user: Pick<IUser, 'provider' | 'role'>,
): boolean {
  return (
    isGovernancePilotEnabled() &&
    user.provider === 'openid' &&
    user.role === SystemRoles.ADMIN
  );
}
