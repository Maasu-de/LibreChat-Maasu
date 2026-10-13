import { useRecoilCallback } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { logger, settleDlpReviewFiles } from '~/utils';
import store from '~/store';

/**
 * Deletes the uploads of every message held for a DLP review that is still undecided. Logout runs
 * it while the session can still delete them, since clearing the state afterwards drops the reviews.
 */
export default function useDeleteUnsentDlpFiles() {
  return useRecoilCallback(
    ({ snapshot }) =>
      async () => {
        const keys = await snapshot.getPromise(store.conversationKeysAtom);
        const files = keys.flatMap((key) => {
          const review = snapshot.getLoadable(store.dlpReviewByIndex(key)).valueMaybe();
          if (!review || review.status === 'sending') {
            return [];
          }
          const submitted = snapshot.getLoadable(store.submittedFilesByIndex(key)).valueMaybe();
          return settleDlpReviewFiles(review, submitted, false).deleted;
        });
        if (files.length === 0) {
          return;
        }
        try {
          await dataService.deleteFiles({ files });
        } catch (error) {
          logger.error('Failed to delete the files of an unsent DLP review', error);
        }
      },
    [],
  );
}
