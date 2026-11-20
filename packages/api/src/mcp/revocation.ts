import type { MCPProviderRevocation } from 'librechat-data-provider';

export function mergeMCPRevocationFailure(
  current: MCPProviderRevocation,
  error: Error & { status?: number },
): MCPProviderRevocation {
  const status = error?.status;
  const httpStatus =
    typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  let reason: MCPProviderRevocation['reason'] = 'provider_error';
  if (httpStatus && httpStatus >= 500) reason = 'provider_unavailable';
  else if (httpStatus && httpStatus >= 400) reason = 'provider_rejected';
  if (current.outcome === 'failure' && reason !== 'provider_unavailable') return current;
  return { outcome: 'failure', reason, ...(httpStatus && { http_status: httpStatus }) };
}
