import { useMutation } from '@tanstack/react-query';
import { dataService, MutationKeys } from 'librechat-data-provider';
import type {
  GovernanceConnectionResponse,
  GovernanceDlpCheckRequest,
  GovernanceDlpCheckResponse,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

export function useGovernanceDlpCheckMutation(): UseMutationResult<
  GovernanceDlpCheckResponse,
  Error,
  GovernanceDlpCheckRequest
> {
  return useMutation({
    mutationKey: [MutationKeys.governanceDlpCheck],
    mutationFn: dataService.checkGovernanceDlp,
  });
}

export const useTestGovernanceConnectionMutation = (): UseMutationResult<
  GovernanceConnectionResponse,
  Error,
  void
> => {
  return useMutation({
    mutationKey: [MutationKeys.testGovernanceConnection],
    mutationFn: dataService.testGovernanceConnection,
  });
};
