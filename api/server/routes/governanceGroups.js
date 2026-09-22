const express = require('express');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');

const router = express.Router();
const PAGE_SIZE = 200;

let jwksClient;
let jwksClientIssuer;

function getJwksClient(issuer) {
  if (!jwksClient || jwksClientIssuer !== issuer) {
    jwksClient = jwksRsa({
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
      cache: true,
      cacheMaxAge: 5 * 60 * 1000,
      rateLimit: true,
    });
    jwksClientIssuer = issuer;
  }
  return jwksClient;
}

function getSigningKey(client, kid) {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

function hasAdminRole(claims, adminRole) {
  const roles = claims?.realm_access?.roles;
  return Array.isArray(roles) && roles.includes(adminRole);
}

/**
 * Authorizes the trusted Governance Admin server by verifying its admin's own
 * Keycloak access token against the shared realm's JWKS -- the same token
 * already authenticating that admin's policy-version calls (see
 * authenticate_administrator in the governance backend) -- rather than
 * requiring a LibreChat user session. There is no LibreChat account behind
 * this call, so it deliberately skips LibreChat's own user lookup.
 */
async function requireGovernanceAdminToken(req, res, next) {
  const issuer = (process.env.OPENID_ISSUER ?? '').replace(/\/+$/, '');
  const audience = process.env.GOVERNANCE_ADMIN_CLIENT_ID ?? '';
  const adminRole = process.env.OPENID_ADMIN_ROLE ?? '';
  if (!issuer || !audience || !adminRole) {
    return res.status(503).json({ message: 'Group lookup is not configured.' });
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const kid = jwt.decode(token, { complete: true })?.header?.kid;
  if (!kid) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  let claims;
  try {
    const signingKey = await getSigningKey(getJwksClient(issuer), kid);
    claims = jwt.verify(token, signingKey, { algorithms: ['RS256'], issuer, audience });
  } catch (error) {
    logger.warn('[GovernanceGroups] Access token verification failed', {
      message: error?.message,
    });
    return res.status(401).json({ message: 'Unauthorized' });
  }

  // Keycloak issues the same signature scheme for ID and refresh tokens;
  // only an access token ("Bearer") proves this is a live admin session.
  if (claims.typ !== 'Bearer' || !hasAdminRole(claims, adminRole)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return next();
}

router.get('/', requireGovernanceAdminToken, async (_req, res) => {
  try {
    const groups = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await db.listGroups({ limit: PAGE_SIZE, offset });
      groups.push(...page);
      if (page.length < PAGE_SIZE) {
        break;
      }
    }

    return res.status(200).json({
      groups: groups.map((group) => ({
        id: group._id.toString(),
        name: group.name,
        source: group.source,
      })),
    });
  } catch (error) {
    logger.error('[GovernanceGroups] Group lookup failed', { message: error?.message });
    return res.status(500).json({ message: 'Unable to list groups.' });
  }
});

module.exports = router;
