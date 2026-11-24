import React, { useState } from 'react';
import { useClearConversationsMutation } from 'librechat-data-provider/react-query';
import {
  OGDialogTemplate,
  Label,
  Button,
  OGDialog,
  OGDialogTrigger,
  Spinner,
  useToastContext,
} from '@librechat/client';
import { clearAllConversationStorage } from '~/utils';
import { useLocalize, useNewConvo } from '~/hooks';
import { NotificationSeverity } from '~/common';

export const ClearChats = () => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [open, setOpen] = useState(false);
  const { newConversation } = useNewConvo();
  const clearConvosMutation = useClearConversationsMutation();

  const clearConvos = () => {
    clearConvosMutation.mutate(
      {},
      {
        onSuccess: (result) => {
          if (result?.cleanupFailures?.length) {
            showToast({
              message: localize('com_ui_chat_delete_cleanup_warning'),
              severity: NotificationSeverity.WARNING,
            });
          }
          clearAllConversationStorage();
          newConversation();
        },
      },
    );
  };

  return (
    <div className="flex items-center justify-between">
      <Label id="clear-all-chats-label">{localize('com_nav_clear_all_chats')}</Label>
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button
            aria-labelledby="clear-all-chats-label"
            variant="destructive"
            onClick={() => setOpen(true)}
          >
            {localize('com_ui_delete')}
          </Button>
        </OGDialogTrigger>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_nav_confirm_clear')}
          className="max-w-[450px]"
          main={
            <Label className="break-words">
              {localize('com_nav_clear_conversation_confirm_message')}
            </Label>
          }
          selection={{
            selectHandler: clearConvos,
            selectClasses:
              'bg-destructive text-white transition-all duration-200 hover:bg-destructive/80',
            selectText: clearConvosMutation.isLoading ? <Spinner /> : localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </div>
  );
};
