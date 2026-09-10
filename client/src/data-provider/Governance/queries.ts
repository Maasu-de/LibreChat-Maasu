import { QueryKeys, dataService } from 'librechat-data-provider';
import { useQuery } from '@tanstack/react-query';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type { FinanceUsageDashboard, FinanceUsageQueryParams } from 'librechat-data-provider';

export const useGovernanceUsageQuery = (
  params: FinanceUsageQueryParams,
  config?: UseQueryOptions<FinanceUsageDashboard>,
): QueryObserverResult<FinanceUsageDashboard> => {
  return useQuery<FinanceUsageDashboard>(
    [QueryKeys.financeUsage, params],
    () => dataService.getGovernanceUsage(params),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      refetchOnMount: true,
      retry: false,
      ...config,
    },
  );
};
