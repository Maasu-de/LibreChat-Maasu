import { SystemRoles } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { RefreshTokenset } from './refresh';
import { isGovernancePilotEnabled } from '../governance/mode';

export const GOVERNANCE_ADMIN_ROLE: SystemRoles.GOVERNANCE_ADMIN = SystemRoles.GOVERNANCE_ADMIN;

function administratorRole(): string {
  return (
    process.env.OPENID_ADMIN_ROLE ??
    process.env.KEYCLOAK_ADMIN_ROLE ??
    'governance-admin'
  ).trim();
}

function administratorClaimPath(): string {
  return (process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH ?? 'realm_access.roles').trim();
}

export function assertOidcAdministratorConfigured(): void {
  if (!isGovernancePilotEnabled()) return;
  if (!administratorRole()) {
    throw new Error(
      'Governed mode requires a non-blank administrator role (OPENID_ADMIN_ROLE or legacy KEYCLOAK_ADMIN_ROLE)',
    );
  }
  if (!administratorClaimPath()) {
    throw new Error('Governed mode requires a non-blank OPENID_ADMIN_ROLE_PARAMETER_PATH');
  }
}

export function hasOidcAdministratorClaim(claims: object): boolean {
  const expected = administratorRole();
  const path = administratorClaimPath();
  if (!expected || !path) return false;
  const parts = Object.prototype.hasOwnProperty.call(claims, path) ? [path] : path.split('.');
  let value: unknown = claims;
  for (const part of parts) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, part)
    ) {
      return false;
    }
    value = Reflect.get(value, part);
  }
  if (typeof value === 'string') return value.trim() === expected;
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === 'string' && item.trim() === expected)
  );
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
    isGovernancePilotEnabled() && user.provider === 'openid' && user.role === SystemRoles.ADMIN
  );
}
