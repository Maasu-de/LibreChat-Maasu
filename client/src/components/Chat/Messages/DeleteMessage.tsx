import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogTemplate,
  OGDialogTrigger,
  useToastContext,
} from '@librechat/client';
import { useDeleteMessageMutation } from '~/data-provider/Messages';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

export default function DeleteMessage({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const deletion = useDeleteMessageMutation(conversationId);
  const title = localize('com_ui_message_delete_title');

  return (
    <OGDialog open={open} onOpenChange={setOpen}>
      <OGDialogTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={title}
          className="hover-button rounded-lg p-1.5 text-text-secondary-alt hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-black dark:focus-visible:ring-white"
          disabled={deletion.isLoading}
        >
          <Trash2 size={19} />
        </button>
      </OGDialogTrigger>
      <OGDialogTemplate
        title={title}
        description={localize('com_ui_message_delete_confirm')}
        className="max-w-md"
        selection={
          <Button
            variant="destructive"
            disabled={deletion.isLoading}
            onClick={() =>
              deletion.mutate(messageId, {
                onSuccess: () => setOpen(false),
                onError: () =>
                  showToast({
                    message: localize('com_ui_message_delete_error'),
                    severity: NotificationSeverity.ERROR,
                  }),
              })
            }
          >
            {localize('com_ui_delete')}
          </Button>
        }
      />
    </OGDialog>
  );
}
