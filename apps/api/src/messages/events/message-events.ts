export const MESSAGE_CREATED = 'message.created';
export const MESSAGE_UPDATED = 'message.updated';
export const MESSAGE_DELETED = 'message.deleted';

export type MessageCreatedPayload = {
  workspaceId: string;
  channelId: string;
  actorId: string;
  message: {
    id: string;
    authorId: string;
    content: string;
    mentions: { users: string[]; channels: string[]; everyone: boolean };
    createdAt: string;
  };
};

export type MessageUpdatedPayload = {
  workspaceId: string;
  channelId: string;
  actorId: string;
  message: {
    id: string;
    authorId: string;
    content: string;
    mentions: { users: string[]; channels: string[]; everyone: boolean };
    editedAt: string;
  };
};

export type MessageDeletedPayload = {
  workspaceId: string;
  channelId: string;
  actorId: string;
  message: { id: string; authorId: string; deletedAt: string };
};
