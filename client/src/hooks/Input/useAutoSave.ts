import debounce from 'lodash/debounce';
import { SetterOrUpdater, useRecoilValue } from 'recoil';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { LocalStorageKeys, Constants } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { clearDraft, getDraft, setDraft } from '~/utils';
import { useChatFormContext } from '~/Providers';
import { useGetFiles } from '~/data-provider';
import store from '~/store';

export const useAutoSave = ({
  isSubmitting,
  conversationId: _conversationId,
  textAreaRef,
  setFiles,
  files,
}: {
  isSubmitting?: boolean;
  conversationId?: string | null;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
  files: Map<string, ExtendedFile>;
  setFiles: SetterOrUpdater<Map<string, ExtendedFile>>;
}) => {
  // setting for auto-save
  const { setValue } = useChatFormContext();
  const saveDrafts = useRecoilValue<boolean>(store.saveDrafts);
  const conversationId = isSubmitting ? Constants.PENDING_CONVO : _conversationId;

  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const fileIds = useMemo(() => Array.from(files.keys()), [files]);
  const { data: fileList } = useGetFiles<TFile[]>();

  const restoreFiles = useCallback(
    (id: string) => {
      const filesDraft = JSON.parse(
        (localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${id}`) ?? '') || '[]',
      ) as string[];

      if (filesDraft.length === 0) {
        setFiles(new Map());
        return;
      }

      // Retrieve files stored in localStorage from files in fileList and set them to `setFiles`
      // If a file is found with `temp_file_id`, use `temp_file_id` as a key in `setFiles`
      filesDraft.forEach((fileId) => {
        const fileData = fileList?.find((f) => f.file_id === fileId);
        const tempFileData = fileList?.find((f) => f.temp_file_id === fileId);
        const { fileToRecover, fileIdToRecover } = fileData
          ? { fileToRecover: fileData, fileIdToRecover: fileId }
          : {
              fileToRecover: tempFileData,
              fileIdToRecover: (tempFileData?.temp_file_id ?? '') || fileId,
            };

        if (fileToRecover) {
          setFiles((currentFiles) => {
            const updatedFiles = new Map(currentFiles);
            updatedFiles.set(fileIdToRecover, {
              ...fileToRecover,
              progress: 1,
              attached: true,
              size: fileToRecover.bytes,
            });
            return updatedFiles;
          });
        }
      });
    },
    [fileList, setFiles],
  );

  const restoreText = useCallback(
    (id: string) => {
      setValue('text', getDraft(id) ?? '');
    },
    [setValue],
  );

  const saveText = useCallback(
    (id: string) => {
      if (!textAreaRef?.current) {
        return;
      }
      // Save the draft of the current conversation before switching
      if (textAreaRef.current.value === '' || textAreaRef.current.value.length === 1) {
        clearDraft(id);
      } else {
        setDraft({ id, value: textAreaRef.current.value });
      }
    },
    [textAreaRef],
  );

  /** Whether the user edited the composer since the draft key last changed. `input` fires for
   * edits only: a send or a restored draft writes the value without it. */
  const composerEditedRef = useRef(false);

  useEffect(() => {
    // This useEffect is responsible for setting up and cleaning up the auto-save functionality
    // for the text area input. It saves the text to localStorage with a debounce to prevent
    // excessive writes.
    const textArea = textAreaRef?.current;
    if (!saveDrafts || conversationId == null || conversationId === '' || !textArea) {
      return;
    }

    /** Reads the composer when the write lands, so a send that cleared it meanwhile is saved as cleared */
    const saveLatest = () => setDraft({ id: conversationId, value: textArea.value });

    /** Use shorter debounce for saving text (25ms) to capture rapid typing */
    const handleInputFast = debounce(saveLatest, 25);

    /** Use longer debounce for clearing empty values (850ms) to prevent accidental draft loss */
    const handleInputSlow = debounce(saveLatest, 850);

    const eventListener = () => {
      composerEditedRef.current = true;

      /** Cancel any pending operations to avoid conflicts */
      handleInputFast.cancel();
      handleInputSlow.cancel();

      /** If empty, use long delay to prevent accidental clearing
       * Otherwise use short delay to capture rapid typing */
      if (textArea.value === '') {
        handleInputSlow();
      } else {
        handleInputFast();
      }
    };

    textArea.addEventListener('input', eventListener);

    return () => {
      textArea.removeEventListener('input', eventListener);
      /** Land pending writes: the key changes the moment a response starts or ends */
      handleInputFast.flush();
      handleInputSlow.flush();
    };
  }, [conversationId, saveDrafts, textAreaRef]);

  const prevConversationIdRef = useRef<string | null>(null);
  /** The conversation a response was generating for, while the draft is parked on PENDING_CONVO */
  const pendingSourceIdRef = useRef<string | null>(null);

  useEffect(() => {
    // This useEffect is responsible for saving the current conversation's draft and
    // restoring the new conversation's draft when switching between conversations.
    // It handles both text and file drafts, ensuring that the user's input is preserved
    // across different conversations.

    if (!saveDrafts || conversationId == null || conversationId === '') {
      return;
    }
    if (conversationId === currentConversationId) {
      return;
    }

    // clear attachment files when switching conversation
    setFiles(new Map());

    try {
      const leavingPending = prevConversationIdRef.current === Constants.PENDING_CONVO;
      // Check for transition from PENDING_CONVO to a valid conversationId
      if (leavingPending && conversationId.length > 3) {
        const pendingDraft = localStorage.getItem(
          `${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`,
        );

        // Clear the pending text draft, if it exists, and save the current draft to the new conversationId;
        // otherwise, save the current text area value to the new conversationId
        localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`);
        if (pendingDraft) {
          localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}${conversationId}`, pendingDraft);
        } else if (textAreaRef?.current?.value) {
          setDraft({ id: conversationId, value: textAreaRef.current.value });
        }
        const pendingFileDraft = localStorage.getItem(
          `${LocalStorageKeys.FILES_DRAFT}${Constants.PENDING_CONVO}`,
        );

        if (pendingFileDraft) {
          localStorage.setItem(
            `${LocalStorageKeys.FILES_DRAFT}${conversationId}`,
            pendingFileDraft,
          );
          localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.PENDING_CONVO}`);
          const filesDraft = JSON.parse(pendingFileDraft || '[]') as string[];
          if (filesDraft.length > 0) {
            restoreFiles(conversationId);
          }
        }
      } else if (leavingPending) {
        localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`);
      } else if (currentConversationId != null && currentConversationId) {
        saveText(currentConversationId);
      }

      /** A response starting or ending in this conversation is not a conversation switch: the
       * composer already holds the newest text, and the stored draft is only a debounced copy
       * that may lag behind it. A new chat counts as the same one once it receives its id.
       * An empty composer only holds the newest text if the user emptied it: left untouched it
       * is still the one the send cleared, and an unsent turn has put its message in the draft. */
      const pendingSource = pendingSourceIdRef.current;
      const isOwnPendingSwap =
        currentConversationId != null &&
        (conversationId === Constants.PENDING_CONVO ||
          (leavingPending &&
            (pendingSource === _conversationId || pendingSource === Constants.NEW_CONVO)));
      const liveText = textAreaRef?.current?.value ?? '';
      if (isOwnPendingSwap && (liveText !== '' || composerEditedRef.current)) {
        setDraft({ id: conversationId, value: liveText });
      } else {
        restoreText(conversationId);
      }
      restoreFiles(conversationId);
    } catch (e) {
      console.error(e);
    }

    composerEditedRef.current = false;
    pendingSourceIdRef.current =
      conversationId === Constants.PENDING_CONVO ? (_conversationId ?? null) : null;
    prevConversationIdRef.current = conversationId;
    setCurrentConversationId(conversationId);
  }, [
    _conversationId,
    currentConversationId,
    conversationId,
    restoreFiles,
    textAreaRef,
    restoreText,
    saveDrafts,
    saveText,
    setFiles,
  ]);

  useEffect(() => {
    // This useEffect is responsible for saving or removing the current conversation's file drafts
    // in localStorage whenever the file attachments change.
    // It ensures that the file drafts are kept up-to-date and can be restored
    // when the conversation is revisited.

    if (
      !saveDrafts ||
      conversationId == null ||
      conversationId === '' ||
      currentConversationId !== conversationId
    ) {
      return;
    }

    if (fileIds.length === 0) {
      localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${conversationId}`);
    } else {
      localStorage.setItem(
        `${LocalStorageKeys.FILES_DRAFT}${conversationId}`,
        JSON.stringify(fileIds),
      );
    }
  }, [files, conversationId, saveDrafts, currentConversationId, fileIds]);
};
