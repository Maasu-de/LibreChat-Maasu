import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { IGroup } from '@librechat/data-schemas';
import type { JwtPayload } from 'jsonwebtoken';
import { normalizeOpenIdIssuer } from '../auth/openid';

const PAGE_SIZE = 200;
const JWKS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type GroupRef = Pick<IGroup, '_id' | 'name'>;
type AdminClaims = JwtPayload & {
  typ?: string;
  realm_access?: { roles?: string[] };
};

export interface GovernanceGroupsDeps {
  listGroups: (filter: { limit: number; offset: number }) => Promise<GroupRef[]>;
}

export interface UserGroupIdsDeps {
  getUserGroups: (
    userId: string,
    projection?: Record<string, 0 | 1>,
  ) => Promise<Pick<IGroup, '_id'>[]>;
}

/** Keyed by the configured issuer (never a token value), so it holds one entry per realm */
const jwksClients = new Map<string, jwksRsa.JwksClient>();

export function clearGovernanceJwksCache(): void {
  jwksClients.clear();
}

function getJwksClient(issuer: string): jwksRsa.JwksClient {
  const cached = jwksClients.get(issuer);
  if (cached) {
    return cached;
  }
  const jwksUri = `${issuer}/protocol/openid-connect/certs`;
  logger.debug('[GovernanceGroups] Creating JWKS client', { jwksUri });
  const client = jwksRsa({
    jwksUri,
    cache: true,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    rateLimit: true,
  });
  jwksClients.set(issuer, client);
  return client;
}

function hasAdminRole(claims: AdminClaims, adminRole: string): boolean {
  const roles = claims.realm_access?.roles;
  return Array.isArray(roles) && roles.includes(adminRole);
}

function readBearer(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

async function verifyAdminToken(
  token: string,
  issuer: string,
  audience: string,
): Promise<AdminClaims | null> {
  const kid = jwt.decode(token, { complete: true })?.header?.kid;
  if (!kid) {
    logger.warn('[GovernanceGroups] Rejected token without a key id');
    return null;
  }

  try {
    const signingKey = await getJwksClient(issuer).getSigningKey(kid);
    return jwt.verify(token, signingKey.getPublicKey(), {
      algorithms: ['RS256'],
      issuer,
      audience,
    }) as AdminClaims;
  } catch (error) {
    logger.warn('[GovernanceGroups] Access token verification failed', {
      message: (error as Error)?.message,
      expectedIssuer: issuer,
      expectedAudience: audience,
    });
    return null;
  }
}

/**
 * Authorizes the trusted Governance Admin server by verifying its admin's own
 * Keycloak access token against the shared realm's JWKS -- the same token
 * already authenticating that admin's policy-version calls (see
 * authenticate_administrator in the governance backend) -- rather than
 * requiring a LibreChat user session. There is no LibreChat account behind
 * this call, so it deliberately skips LibreChat's own user lookup.
 */
export async function requireGovernanceAdminToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // OPENID_ISSUER may be the discovery URL; the JWKS path and `iss` claim need the bare issuer
  const issuer = normalizeOpenIdIssuer(process.env.OPENID_ISSUER) ?? '';
  const audience = process.env.GOVERNANCE_ADMIN_CLIENT_ID ?? '';
  const adminRole = process.env.OPENID_ADMIN_ROLE ?? '';
  if (!issuer || !audience || !adminRole) {
    logger.warn('[GovernanceGroups] Group lookup is not configured', {
      hasIssuer: Boolean(issuer),
      hasAudience: Boolean(audience),
      hasAdminRole: Boolean(adminRole),
    });
    res.status(503).json({ message: 'Group lookup is not configured.' });
    return;
  }

  const token = readBearer(req.headers.authorization);
  const claims = token ? await verifyAdminToken(token, issuer, audience) : null;

  // Keycloak issues the same signature scheme for ID and refresh tokens;
  // only an access token ("Bearer") proves this is a live admin session.
  if (claims?.typ !== 'Bearer' || !hasAdminRole(claims, adminRole)) {
    if (!token) {
      logger.warn('[GovernanceGroups] Rejected request without a bearer token');
    } else if (claims) {
      logger.warn('[GovernanceGroups] Rejected verified token', {
        typ: claims.typ,
        hasAdminRole: hasAdminRole(claims, adminRole),
      });
    }
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
      /** The Governance Admin manages the whole deployment, so this read is deliberately cross-tenant */
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
