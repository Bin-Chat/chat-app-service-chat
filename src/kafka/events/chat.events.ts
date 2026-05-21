export const CHAT_EVENTS = {
  MESSAGE_CREATED: 'chat.message.created',
  MESSAGE_REVOKED: 'chat.message.revoked',
  MESSAGE_EDITED: 'chat.message.edited',
  MESSAGE_PINNED: 'chat.message.pinned',
  MESSAGE_UNPINNED: 'chat.message.unpinned',
  CONVERSATION_UPDATED: 'chat.conversation.updated',
  CONVERSATION_SETTINGS_UPDATED: 'chat.conversation.settings_updated',
  REACTION_TOGGLED: 'chat.reaction.toggled',
  MEMBER_BANNED: 'chat.member.banned',
  MEMBER_UNBANNED: 'chat.member.unbanned',
  // Group events
  GROUP_MEMBERS_ADDED: 'chat.group.members_added',
  GROUP_MEMBER_REMOVED: 'chat.group.member_removed',
  GROUP_MEMBER_LEFT: 'chat.group.member_left',
  GROUP_UPDATED: 'chat.group.updated',
  GROUP_ROLE_CHANGED: 'chat.group.role_changed',
  GROUP_DISSOLVED: 'chat.group.dissolved',
  GROUP_OWNER_TRANSFERRED: 'chat.group.owner_transferred',
  // Reminders
  REMINDER_FIRED: 'chat.reminder.fired',
  REMINDER_UPDATED: 'chat.reminder.updated',
  REMINDER_DELETED: 'chat.reminder.deleted',
  // Notes
  NOTE_CREATED: 'chat.note.created',
  NOTE_UPDATED: 'chat.note.updated',
  NOTE_DELETED: 'chat.note.deleted',
  // Polls
  POLL_CREATED: 'chat.poll.created',
  POLL_VOTED: 'chat.poll.voted',
  POLL_OPTION_ADDED: 'chat.poll.option_added',
  POLL_UPDATED: 'chat.poll.updated',
  POLL_CLOSED: 'chat.poll.closed',
  POLL_DELETED: 'chat.poll.deleted',
};

export interface MessageCreatedEvent {
  messageId: string;
  conversationId: string;
  senderId: string;
  participants: string[];
  content: string;
  type: string;
  attachments: any[];
  createdAt: Date;
}

export interface MessageRevokedEvent {
  messageId: string;
  conversationId: string;
  senderId: string;
  participants: string[];
  revokedAt: Date;
}

export interface ConversationUpdatedEvent {
  conversationId: string;
  participants: string[];
  lastMessage: {
    senderId: string;
    content: string;
    type: string;
    sentAt: Date;
  };
}

export interface ReactionToggledEvent {
  messageId: string;
  conversationId: string;
  participants: string[];
  userId: string;
  emoji: string;
  action: 'added' | 'removed';
}

// ── Group events ──────────────────────────────────────────────────────────

export interface GroupMembersAddedEvent {
  conversationId: string;
  addedBy: string;
  newMemberIds: string[];
  participants: string[];
}

export interface GroupMemberRemovedEvent {
  conversationId: string;
  removedBy: string;
  removedMemberId: string;
  participants: string[];
}

export interface GroupMemberLeftEvent {
  conversationId: string;
  userId: string;
  participants: string[];
}

export interface GroupUpdatedEvent {
  conversationId: string;
  updatedBy: string;
  changes: { name?: string; avatar?: string; description?: string };
  participants: string[];
}

export interface GroupRoleChangedEvent {
  conversationId: string;
  changedBy: string;
  memberId: string;
  newRole: string;
  participants: string[];
}

export interface GroupDissolvedEvent {
  conversationId: string;
  dissolvedBy: string;
  participants: string[];
}

export interface GroupOwnerTransferredEvent {
  conversationId: string;
  oldOwnerId: string;
  newOwnerId: string;
  participants: string[];
}
