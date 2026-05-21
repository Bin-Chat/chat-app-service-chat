import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ConversationDocument = Conversation & Document;

@Schema({ _id: false })
export class Participant {
  @Prop({ required: true })
  userId: string;

  @Prop({ enum: ['owner', 'admin', 'member'], default: 'member' })
  role: 'owner' | 'admin' | 'member';

  @Prop({ default: () => new Date() })
  joinedAt: Date;

  // Ban
  @Prop({ default: false })
  isBanned: boolean;

  @Prop({ type: Date, default: null })
  bannedUntil: Date | null;

  // Per-user conversation prefs
  @Prop({ default: false })
  isPinned: boolean;

  @Prop({ default: false })
  isArchived: boolean;

  @Prop({ default: false })
  isMuted: boolean;

  @Prop({ type: Date, default: null })
  muteUntil: Date | null;

  @Prop({ type: Date, default: null })
  lastReadAt: Date | null;
}

@Schema({ _id: false })
export class LastMessage {
  @Prop()
  messageId: string;

  @Prop()
  senderId: string;

  @Prop()
  content: string;

  @Prop({ default: 'text' })
  type: string;

  @Prop()
  sentAt: Date;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;
}

@Schema({ _id: false })
export class ConversationSettings {
  @Prop({ default: false })
  onlyAdminCanSend: boolean;

  @Prop({ default: true })
  allowMemberInvite: boolean;

  @Prop({ default: false })
  requireJoinApproval: boolean;

  @Prop({ default: true })
  chatHistoryForNewMembers: boolean;
}

@Schema({ _id: false })
export class PendingMember {
  @Prop({ required: true })
  userId: string;

  @Prop({ default: () => new Date() })
  requestedAt: Date;
}

@Schema({ _id: false })
export class PinnedMessage {
  @Prop({ required: true })
  messageId: string;

  @Prop({ required: true })
  pinnedBy: string;

  @Prop({ default: () => new Date() })
  pinnedAt: Date;
}

@Schema({ timestamps: true, collection: 'conversations' })
export class Conversation {
  _id: Types.ObjectId;

  @Prop({ required: true, enum: ['direct', 'group'], default: 'direct' })
  type: 'direct' | 'group';

  @Prop({ type: [Participant], default: [] })
  participants: Participant[];

  @Prop({ type: LastMessage, default: null })
  lastMessage: LastMessage | null;

  @Prop()
  name?: string;

  @Prop()
  avatar?: string;

  @Prop()
  description?: string;

  @Prop({ type: ConversationSettings, default: () => ({}) })
  settings: ConversationSettings;

  @Prop({ type: [PinnedMessage], default: [] })
  pinnedMessages: PinnedMessage[];

  @Prop({ type: [PendingMember], default: [] })
  pendingMembers: PendingMember[];

  @Prop({ type: String, default: null })
  inviteToken: string | null;

  @Prop({ default: false })
  inviteEnabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
