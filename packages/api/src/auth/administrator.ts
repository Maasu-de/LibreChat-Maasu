import get from 'lodash/get';
import jwt from 'jsonwebtoken';
import { SystemRoles } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { RefreshTokenset } from './refresh';
import { isGovernancePilotEnabled } from '../governance/mode';

export function requiresOidcEntitlementRefresh(user: Pick<IUser, 'provider'>): boolean {
  return isGovernancePilotEnabled() && user.provider === 'openid';
}

export function hasOidcAdministratorClaim(claims: object): boolean {
  const role = process.env.OPENID_ADMIN_ROLE ?? 'governance-admin';
  const value = get(claims, process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH ?? 'realm_access.roles');
  if (value === true) return true;
  const values = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  return Array.isArray(values) && values.includes(role);
}

/** Tokensets must come from the validated OIDC login or refresh grant. */
export async function syncOidcAdministrator(
  user: IUser,
  tokenset: RefreshTokenset,
  updateUser: (id: string, data: Partial<IUser>) => Promise<IUser | null>,
  getUserInfo?: (accessToken: string, subject: string) => Promise<{ sub?: string } | null>,
): Promise<void> {
  if (!process.env.OPENID_ADMIN_ROLE) return;
  const source = process.env.OPENID_ADMIN_ROLE_TOKEN_KIND ?? 'access';
  let claims: object | null = null;
  if (source === 'id') claims = tokenset.claims();
  else if (source === 'access') {
    const decoded = tokenset.access_token ? jwt.decode(tokenset.access_token) : null;
    claims = typeof decoded === 'object' ? decoded : null;
  } else if (source === 'userinfo' && getUserInfo && tokenset.access_token) {
    const subject = tokenset.claims().sub;
    if (!subject) throw new Error('Missing OIDC subject');
    const info = await getUserInfo(tokenset.access_token, subject);
    if (!info) throw new Error('OIDC userinfo unavailable');
    if (info.sub !== subject) throw new Error('OIDC subject mismatch');
    claims = info;
  } else throw new Error('Unsupported OIDC administrator source');
  if (!claims) throw new Error('Missing OIDC administrator claims');
  let role = user.role;
  if (hasOidcAdministratorClaim(claims)) role = SystemRoles.ADMIN;
  else if (role === SystemRoles.ADMIN) role = SystemRoles.USER;
  if (role === user.role) return;
  const updated = await updateUser(user._id.toString(), { role });
  if (!updated) throw new Error('Unable to synchronize OIDC administrator');
  user.role = role;
}
