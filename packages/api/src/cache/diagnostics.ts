import { CacheKeys } from 'librechat-data-provider';
import { isGovernancePilotEnabled } from '~/governance/mode';

interface CacheDiagnostics<T> {
  count: number;
  ttl: number | undefined;
  keys?: string[];
  entriesWithTimestamps?: { key: string; value: T }[];
}

export function getCacheDiagnostics<T>(
  namespace: string | undefined,
  ttl: number | undefined,
  store: Pick<Map<string, T>, 'size' | 'keys' | 'entries'>,
): CacheDiagnostics<T> {
  const summary = { count: store.size, ttl };
  if (namespace === CacheKeys.FLOWS && isGovernancePilotEnabled()) {
    return summary;
  }
  return {
    ...summary,
    keys: Array.from(store.keys()),
    entriesWithTimestamps: Array.from(store.entries(), ([key, value]) => ({ key, value })),
  };
}
