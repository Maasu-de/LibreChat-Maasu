import { isEnabled } from '~/utils/common';

export const GOVERNANCE_ENDPOINT = 'AI Governance Gateway';

export function isGovernancePilotEnabled(): boolean {
  return isEnabled(process.env.GOVERNANCE_PILOT_ENABLED);
}

/**
 * Test-only switch for issue #150: lifts the pilot's attachment restrictions so the current,
 * ungoverned attachment path can be observed. Every other pilot restriction stays in force.
 */
export function isGovernanceAttachmentTestEnabled(): boolean {
  return isGovernancePilotEnabled() && isEnabled(process.env.GOVERNANCE_PILOT_TEST_ATTACHMENTS);
}
