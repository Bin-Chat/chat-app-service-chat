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
}

@Schema({ _id: false })
export class LastMessage {
  @Prop()
  senderId: string;

  @Prop()
  content: string;

  @Prop({ default: 'text' })
  type: string;

  @Prop()
  sentAt: Date;
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

  createdAt: Date;
  updatedAt: Date;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

// Index: efficiently find conversations for a participant
ConversationSchema.index({ 'participants.userId': 1 });
// Index: order by most recent message
ConversationSchema.index({ 'lastMessage.sentAt': -1 });
