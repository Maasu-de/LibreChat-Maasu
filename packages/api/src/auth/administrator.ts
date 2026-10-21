import get from 'lodash/get';
import jwt from 'jsonwebtoken';
import { SystemRoles } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { RefreshTokenset } from './refresh';

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
  userinfoEndpoint?: string,
): Promise<void> {
  if (!process.env.OPENID_ADMIN_ROLE) return;
  const source = process.env.OPENID_ADMIN_ROLE_TOKEN_KIND ?? 'access';
  let claims: object | null = null;
  if (source === 'id') claims = tokenset.claims();
  else if (source === 'access') {
    const decoded = tokenset.access_token ? jwt.decode(tokenset.access_token) : null;
    claims = typeof decoded === 'object' ? decoded : null;
  } else if (source === 'userinfo' && userinfoEndpoint && tokenset.access_token) {
    const response = await fetch(userinfoEndpoint, {
      headers: { authorization: `Bearer ${tokenset.access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('OIDC userinfo unavailable');
    const info = (await response.json()) as { sub?: string };
    if (info.sub !== tokenset.claims().sub) throw new Error('OIDC subject mismatch');
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
