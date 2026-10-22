import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { RequestHandler, Request, Response } from 'express';
import type { IGroup } from '@librechat/data-schemas';
import type { JwtPayload } from 'jsonwebtoken';
import { hasOidcAdministratorClaim } from '../auth/administrator';
import { normalizeOpenIdIssuer } from '../auth/openid';
import { hasGovernanceTokenSource } from './token';

const PAGE_SIZE = 200;
const JWKS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type GroupRef = Pick<IGroup, '_id' | 'name'>;
type AdminClaims = JwtPayload & {
  typ?: string;
};

export interface GovernanceGroupsDeps {
  listGroups: (filter: { limit: number; offset: number }) => Promise<GroupRef[]>;
}

export interface GovernanceAdminTokenDeps {
  exchangeAccessToken: (accessToken: string, subject: string) => Promise<string>;
}

export interface UserGroupIdsDeps {
  getUserGroups: (
    userId: string,
    projection?: Record<string, 0 | 1>,
  ) => Promise<Pick<IGroup, '_id'>[]>;
}

/** Keyed by the configured issuer (never a token value), so it holds one entry per realm */
type OidcSigningKeys = { client: jwksRsa.JwksClient; issuer: string };
const jwksClients = new Map<string, OidcSigningKeys>();

export function clearGovernanceJwksCache(): void {
  jwksClients.clear();
}

async function getJwksClient(issuer: string): Promise<OidcSigningKeys> {
  const cached = jwksClients.get(issuer);
  if (cached) {
    return cached;
  }
  let jwksUri = process.env.OIDC_JWKS_URI || `${issuer}/protocol/openid-connect/certs`;
  let tokenIssuer = issuer;
  if (!issuer.includes('/realms/')) {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('OIDC discovery unavailable');
    const metadata = (await response.json()) as { issuer: string; jwks_uri: string };
    if (metadata.issuer.replace(/\/$/, '') !== issuer) throw new Error('OIDC issuer mismatch');
    jwksUri = process.env.OIDC_JWKS_URI || metadata.jwks_uri;
    tokenIssuer = metadata.issuer;
  }
  logger.debug('[GovernanceGroups] Creating JWKS client', { jwksUri });
  const client = jwksRsa({
    jwksUri,
    cache: true,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    rateLimit: true,
  });
  const keys = { client, issuer: tokenIssuer };
  jwksClients.set(issuer, keys);
  return keys;
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
    const keys = await getJwksClient(issuer);
    const signingKey = await keys.client.getSigningKey(kid);
    return jwt.verify(token, signingKey.getPublicKey(), {
      algorithms: ['RS256'],
      issuer: keys.issuer,
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
 * Authorizes the trusted Admin Panel server by verifying its admin's own
 * selected OIDC token against the issuer's JWKS -- the same token
 * already authenticating that admin's policy-version calls (see
 * authenticate_administrator in the governance backend) -- rather than
 * requiring a LibreChat user session. Untyped tokens additionally require the
 * Gateway's source attestation. There is no LibreChat account behind this call,
 * so it deliberately skips LibreChat's own user lookup.
 */
export function createRequireGovernanceAdminToken({
  exchangeAccessToken,
}: GovernanceAdminTokenDeps): RequestHandler {
  return async (req, res, next): Promise<void> => {
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
    const source = process.env.OPENID_ADMIN_ROLE_TOKEN_KIND ?? 'access';
    if (!['access', 'id', 'userinfo'].includes(source)) {
      res.status(503).json({ message: 'Unsupported OIDC administrator source' });
      return;
    }
    const claims = token ? await verifyAdminToken(token, issuer, audience) : null;
    let roleClaims: object | null = claims;
    if (claims?.sub && source === 'userinfo') {
      try {
        let endpoint =
          process.env.OIDC_USERINFO_URI || `${issuer}/protocol/openid-connect/userinfo`;
        if (!issuer.includes('/realms/') && !process.env.OIDC_USERINFO_URI) {
          const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!discovery.ok) throw new Error('OIDC discovery unavailable');
          const metadata = (await discovery.json()) as {
            issuer: string;
            userinfo_endpoint: string;
          };
          if (metadata.issuer.replace(/\/$/, '') !== issuer)
            throw new Error('OIDC issuer mismatch');
          endpoint = metadata.userinfo_endpoint;
        }
        const userinfoToken = await exchangeAccessToken(token, claims.sub);
        const response = await fetch(endpoint, {
          headers: { authorization: `Bearer ${userinfoToken}` },
          signal: AbortSignal.timeout(5000),
        });
        const info = response.ok ? ((await response.json()) as { sub?: string }) : null;
        roleClaims = info?.sub === claims.sub ? info : null;
      } catch {
        roleClaims = null;
      }
    }

    // The configured source determines which JWT the trusted Gateway forwards.
    if (
      !claims?.sub ||
      typeof claims.exp !== 'number' ||
      !hasGovernanceTokenSource(
        token,
        claims,
        jwt.decode(token, { complete: true })?.header.typ,
        source,
        req.get('x-governance-token-proof'),
      ) ||
      (claims.azp !== undefined && claims.azp !== audience) ||
      !roleClaims ||
      !hasOidcAdministratorClaim(roleClaims)
    ) {
      if (!token) {
        logger.warn('[GovernanceGroups] Rejected request without a bearer token');
      } else if (claims) {
        logger.warn('[GovernanceGroups] Rejected verified token', {
          typ: claims.typ,
          hasAdminRole: roleClaims ? hasOidcAdministratorClaim(roleClaims) : false,
        });
      }
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    next();
  };
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
      /** The Admin Panel manages the whole deployment, so this read is deliberately cross-tenant */
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
