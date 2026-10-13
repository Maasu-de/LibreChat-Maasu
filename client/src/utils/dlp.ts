import type { BatchFile } from 'librechat-data-provider';
import type { ExtendedFile, TPendingDlpReview } from '~/common';

/** True for a file uploaded for the message itself, unlike one attached from the user's files. */
const isMessageUpload = (
  file: ExtendedFile,
): file is ExtendedFile & Required<Pick<BatchFile, 'filepath' | 'source'>> =>
  Boolean(file.temp_file_id) &&
  Boolean(file.filepath) &&
  file.source != null &&
  file.embedded !== true;

/**
 * Splits the composer files of a reviewed message that was not sent. Uploads named in the review's
 * file findings are deleted. The other files go back to the composer, or, without `restore`, the
 * uploads among them are deleted as well. Files attached from the user's files are never deleted.
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
  const flagged = new Set(
    review.result.fileFindings?.flatMap(({ fileId }) => (fileId != null ? [fileId] : [])),
  );
  for (const [key, file] of submitted) {
    if (!reviewed.has(file.file_id)) {
      continue;
    }
    const isFlagged = flagged.has(file.file_id);
    if (restore && !isFlagged) {
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
