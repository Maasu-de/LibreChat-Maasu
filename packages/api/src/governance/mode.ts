import { isEnabled } from '~/utils/common';

export { GOVERNANCE_ENDPOINT } from 'librechat-data-provider';

export function isGovernancePilotEnabled(): boolean {
  return isEnabled(process.env.GOVERNANCE_PILOT_ENABLED);
}

/**
 * Allows text attachments in pilot mode (#150): files of `GOVERNANCE_ATTACHMENT_MIME_TYPES` are
 * uploaded as text and sent inside the message, so the gateway's DLP scan covers them. Every
 * other pilot restriction stays in force.
 */
export function isGovernanceAttachmentsEnabled(): boolean {
  return isGovernancePilotEnabled() && isEnabled(process.env.GOVERNANCE_ATTACHMENTS_ENABLED);
}
