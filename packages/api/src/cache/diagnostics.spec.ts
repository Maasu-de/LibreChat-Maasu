import { Keyv } from 'keyv';
import { CacheKeys, Time } from 'librechat-data-provider';
import { getCacheDiagnostics } from './diagnostics';

const environment = process.env;

afterEach(() => {
  process.env = environment;
});

it('omits administrator OAuth secrets from governed flow-cache diagnostics, including legacy entries', async () => {
  process.env = { ...environment, GOVERNANCE_PILOT_ENABLED: 'true' };
  const rawStore = new Map<string, string>();
  const ttl = Time.TEN_MINUTES;
  const cache = new Keyv({ store: rawStore, namespace: CacheKeys.FLOWS, ttl });
  const secrets = {
    access_token: 'administrator-access-secret',
    refresh_token: 'administrator-refresh-secret',
    client_secret: 'administrator-client-secret',
    codeVerifier: 'administrator-pkce-secret',
  };
  const flow = {
    type: 'mcp_oauth',
    status: 'COMPLETED',
    metadata: {
      clientInfo: { client_secret: secrets.client_secret },
      codeVerifier: secrets.codeVerifier,
    },
    result: {
      access_token: secrets.access_token,
      refresh_token: secrets.refresh_token,
    },
  };
  await cache.set('mcp_oauth:administrator:remote', flow);
  expect(JSON.stringify(Array.from(rawStore.values()))).toContain(secrets.access_token);

  const diagnostics = getCacheDiagnostics(CacheKeys.FLOWS, ttl, rawStore);
  const logged = JSON.stringify(diagnostics);
  expect(diagnostics).toEqual({ count: 1, ttl });
  for (const secret of Object.values(secrets)) {
    expect(logged).not.toContain(secret);
  }
  expect(await cache.get('mcp_oauth:administrator:remote')).toEqual(flow);
});

it.each(['false', undefined])(
  'retains ordinary flow-cache diagnostics outside governed mode (%s)',
  (mode) => {
    process.env = { ...environment };
    if (mode === undefined) delete process.env.GOVERNANCE_PILOT_ENABLED;
    else process.env.GOVERNANCE_PILOT_ENABLED = mode;
    const store = new Map([['ordinary-flow', 'serialized-flow-state']]);
    expect(getCacheDiagnostics(CacheKeys.FLOWS, Time.TEN_MINUTES, store)).toEqual({
      count: 1,
      ttl: Time.TEN_MINUTES,
      keys: ['ordinary-flow'],
      entriesWithTimestamps: [{ key: 'ordinary-flow', value: 'serialized-flow-state' }],
    });
  },
);

it('retains diagnostics for other cache namespaces in governed mode', () => {
  process.env = { ...environment, GOVERNANCE_PILOT_ENABLED: 'true' };
  const store = new Map([['model', 'serialized-model-config']]);
  expect(getCacheDiagnostics(CacheKeys.MODEL_QUERIES, Time.TEN_MINUTES, store)).toEqual({
    count: 1,
    ttl: Time.TEN_MINUTES,
    keys: ['model'],
    entriesWithTimestamps: [{ key: 'model', value: 'serialized-model-config' }],
  });
});
