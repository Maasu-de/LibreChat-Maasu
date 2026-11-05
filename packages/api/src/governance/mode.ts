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

/** Uploaded file references whose content can join a governed text submission. */
export function hasGovernanceFileReferences(files: unknown): boolean {
  return (
    isGovernanceAttachmentsEnabled() &&
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(
      (file) =>
        file != null &&
        typeof file === 'object' &&
        !Array.isArray(file) &&
        typeof file.file_id === 'string' &&
        file.file_id.trim().length > 0,
    )
  );
}
