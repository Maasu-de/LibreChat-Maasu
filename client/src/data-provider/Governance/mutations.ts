import { useMutation } from '@tanstack/react-query';
import { dataService, MutationKeys } from 'librechat-data-provider';
import type {
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
