import { useMutation } from '@tanstack/react-query';
import { dataService, MutationKeys } from 'librechat-data-provider';
import type { GovernanceConnectionResponse } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

export const useTestGovernanceConnectionMutation = (): UseMutationResult<
  GovernanceConnectionResponse,
  Error,
  void
> => {
  return useMutation([MutationKeys.testGovernanceConnection], {
    mutationFn: () => dataService.testGovernanceConnection(),
  });
};
