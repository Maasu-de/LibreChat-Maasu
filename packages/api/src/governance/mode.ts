import { isEnabled } from '~/utils/common';

export const GOVERNANCE_ENDPOINT = 'AI Governance Gateway';

export function isGovernancePilotEnabled(): boolean {
  return isEnabled(process.env.GOVERNANCE_PILOT_ENABLED);
}
