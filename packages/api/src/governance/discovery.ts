import { fetchOpenId } from '../auth/proxy';

interface Metadata {
  issuer: string;
  jwks_uri: string;
  userinfo_endpoint: string;
}
const cache = new Map<string, { metadata: Metadata; expiresAt: number }>();
const requests = new Map<string, Promise<Metadata>>();

export function clearGovernanceDiscoveryCache(): void {
  cache.clear();
  requests.clear();
}

export async function governanceOidcMetadata(issuer: string): Promise<Metadata> {
  const cached = cache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  const pending = requests.get(issuer);
  if (pending) return pending;
  const request = (async () => {
    const response = await fetchOpenId(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('OIDC discovery unavailable');
    const metadata = (await response.json()) as Metadata;
    if (metadata.issuer.replace(/\/$/, '') !== issuer) throw new Error('OIDC issuer mismatch');
    cache.set(issuer, { metadata, expiresAt: Date.now() + 300000 });
    return metadata;
  })();
  requests.set(issuer, request);
  try {
    return await request;
  } finally {
    requests.delete(issuer);
  }
}
