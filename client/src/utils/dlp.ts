import { GOVERNANCE_DLP_TEXT_LOCATION } from 'librechat-data-provider';
import type { BatchFile, GovernanceDlpResult } from 'librechat-data-provider';
import type { ExtendedFile, TPendingDlpReview } from '~/common';

/** The text a review approves: the masked preview of the typed message. */
export const getApprovedDlpText = (result: GovernanceDlpResult): string | undefined =>
  result.maskedPreview?.find((item) => item.location === GOVERNANCE_DLP_TEXT_LOCATION)?.text;

/**
 * Whether the composer still shows the unsent message a review is about. A turn that ends unsent
 * puts its text back as the draft: the typed text when a review opens, the approved text when its
 * send failed. Any other text was typed for the next message.
 */
export const isUnsentDlpText = (review: TPendingDlpReview, text: string): boolean =>
  text === review.text || text === getApprovedDlpText(review.result);

/** True for a file uploaded for the message itself, unlike one attached from the user's files. */
const isMessageUpload = (
  file: ExtendedFile,
): file is ExtendedFile & Required<Pick<BatchFile, 'filepath' | 'source'>> =>
  Boolean(file.temp_file_id) &&
  Boolean(file.filepath) &&
  file.source != null &&
  file.embedded !== true;

/**
 * Splits the composer files of a reviewed message that was not sent. Uploads with a blocked
 * finding are deleted, since they can never be sent. The other files go back to the composer, so
 * the user can change the message and send them again, or, without `restore`, the uploads among
 * them are deleted as well. Files attached from the user's files are never deleted.
 */
export function settleDlpReviewFiles(
  review: TPendingDlpReview,
  submitted: Map<string, ExtendedFile> | null | undefined,
  restore: boolean,
): { restored: Map<string, ExtendedFile>; deleted: BatchFile[] } {
  const restored = new Map<string, ExtendedFile>();
  const deleted: BatchFile[] = [];
  if (!submitted || submitted.size === 0) {
    return { restored, deleted };
  }

  const reviewed = new Set(review.files?.map((file) => file.file_id));
  const blocked = new Set(
    review.result.fileFindings?.flatMap(({ fileId, action }) =>
      fileId != null && action === 'BLOCK' ? [fileId] : [],
    ),
  );
  for (const [key, file] of submitted) {
    if (!reviewed.has(file.file_id)) {
      continue;
    }
    if (restore && !blocked.has(file.file_id)) {
      restored.set(key, { ...file });
      continue;
    }
    if (isMessageUpload(file)) {
      deleted.push({
        file_id: file.file_id,
        filepath: file.filepath,
        source: file.source,
        embedded: false,
      });
    }
  }
  return { restored, deleted };
}
