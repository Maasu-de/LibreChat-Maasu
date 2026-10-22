import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JwtPayload } from 'jsonwebtoken';

function verifyTokenProof(token: string, source: string, proof?: string): boolean {
  const secret = process.env.LIBRECHAT_SERVICE_CREDENTIAL;
  if (!secret || !proof || !/^[0-9]{10}\.[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  const [issuedAt, signature] = proof.split('.');
  const age = Date.now() / 1000 - Number(issuedAt);
  if (age < -5 || age > 60) return false;
  const expected = createHmac('sha256', secret)
    .update(`governance-admin-token:v1\n${source}\n${issuedAt}\n${token}`)
    .digest('base64url');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** Untyped JWTs require the trusted Gateway to attest which OIDC token it selected. */
export function hasGovernanceTokenSource(
  token: string,
  claims: JwtPayload,
  headerType: string | undefined,
  source: string,
  proof?: string,
): boolean {
  const expected = source === 'id' ? 'id' : 'access';
  const accessHeader = typeof headerType === 'string' && headerType.toLowerCase() === 'at+jwt';
  if (claims.token_use !== undefined && claims.token_use !== expected) return false;
  if (accessHeader && expected !== 'access') return false;
  if (Object.hasOwn(claims, 'typ')) return claims.typ === (source === 'id' ? 'ID' : 'Bearer');
  if (claims.token_use === 'id' || claims.token_use === 'access')
    return claims.token_use === expected;
  if (accessHeader) return expected === 'access';
  return verifyTokenProof(token, source, proof);
}
