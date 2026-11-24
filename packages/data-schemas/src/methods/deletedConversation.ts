import type { mongo } from 'mongoose';

type DeletedConversation = {
  _id: { user: string; conversationId: string };
};

export function deletedConversations(
  mongoose: typeof import('mongoose'),
): mongo.Collection<DeletedConversation> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Conversation deletion database unavailable');
  return db.collection<DeletedConversation>('governance_deleted_conversations');
}
