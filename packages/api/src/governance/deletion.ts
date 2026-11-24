import { logger } from '@librechat/data-schemas';
import type { ConversationMethods, MessageMethods, ToolCallMethods } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import { deleteSharedLinksForConversations } from '~/shared-links/service';
import { commitAuditedChatDeletion } from './audit';

type DeletionRequest = Pick<ServerRequest, 'user'>;
type ConversationDeletionResponse = Awaited<ReturnType<ConversationMethods['deleteConvos']>> & {
  cleanupFailures?: string[];
};

export async function deleteGovernanceMessage(
  req: DeletionRequest,
  db: Pick<MessageMethods, 'deleteMessageAndReconnectReplies'>,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const user = req.user?.id;
  if (!user) throw new Error('Authenticated user is required');
  const cleanupSearch = await commitAuditedChatDeletion(req, async (session) => {
    const deleted = await db.deleteMessageAndReconnectReplies(
      { user, conversationId, messageId },
      session,
    );
    return {
      result: deleted?.cleanupSearch,
      deletedCount: Number(deleted !== null),
      resource: {
        scope: 'message',
        conversation_id: conversationId,
        message_id: messageId,
        ...(deleted?.requestMessageId ? { request_message_id: deleted.requestMessageId } : {}),
      },
    };
  });
  try {
    await cleanupSearch?.();
  } catch {
    logger.warn('[Governance deletion] Post-commit cleanup failed', {
      cleanupFailures: ['search_index'],
    });
  }
}

export async function deleteGovernanceConversations(
  req: DeletionRequest,
  db: Pick<ConversationMethods, 'deleteConvos'> & Pick<ToolCallMethods, 'deleteToolCalls'>,
  conversationId?: string,
): Promise<ConversationDeletionResponse> {
  const user = req.user?.id;
  if (!user) throw new Error('Authenticated user is required');
  const { conversationIds, cleanup, cleanupSearch, ...result } = await commitAuditedChatDeletion(
    req,
    async (session) => {
      const result = await db.deleteConvos(user, conversationId ? { conversationId } : {}, session);
      return {
        result,
        deletedCount: result.deletedCount,
        resource: conversationId
          ? { scope: 'conversation', conversation_id: conversationId }
          : { scope: 'all_conversations', conversation_ids: result.conversationIds },
      };
    },
  );

  if (!conversationIds.length) return result;
  const tasks = {
    conversation_metadata: cleanup,
    search_index: cleanupSearch,
    tool_calls: () => db.deleteToolCalls(user, conversationIds),
    shared_links: () => deleteSharedLinksForConversations(user, conversationIds),
  };
  const entries = Object.entries(tasks);
  const outcomes = await Promise.allSettled(entries.map(async ([, run]) => run()));
  const cleanupFailures = entries.flatMap(([name], index) =>
    outcomes[index].status === 'rejected' ? [name] : [],
  );
  if (!cleanupFailures.length) return result;

  logger.warn('[Governance deletion] Post-commit cleanup failed', { cleanupFailures });
  return { ...result, cleanupFailures };
}
