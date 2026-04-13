import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MessageDocument = Message & Document;

@Schema({ _id: false })
export class Attachment {
  @Prop({ required: true })
  url: string;

  @Prop({ required: true, enum: ['image', 'video', 'file'] })
  type: 'image' | 'video' | 'file';

  @Prop({ required: true })
  filename: string;

  @Prop({ required: true })
  size: number;

  @Prop({ required: true })
  mimeType: string;

  @Prop()
  width?: number;

  @Prop()
  height?: number;

  @Prop()
  duration?: number;

  @Prop()
  thumbnailUrl?: string;
}

@Schema({ _id: false })
export class Reaction {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  emoji: string;
}

@Schema({ _id: false })
export class ReadReceipt {
  @Prop({ required: true })
  userId: string;

  @Prop({ default: () => new Date() })
  readAt: Date;
}

@Schema({ _id: false })
export class ReplyInfo {
  @Prop({ required: true })
  messageId: string;

  @Prop({ required: true })
  senderId: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ enum: ['image', 'video', 'file'] })
  attachmentType?: string;
}

@Schema({ _id: false })
export class ForwardInfo {
  @Prop({ required: true })
  messageId: string;

  @Prop({ required: true })
  conversationId: string;

  @Prop({ required: true })
  senderId: string;
}

@Schema({ timestamps: true, collection: 'messages' })
export class Message {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true, index: true })
  conversationId: Types.ObjectId;

  @Prop({ required: true })
  senderId: string;

  @Prop({ required: true, enum: ['text', 'image', 'video', 'file', 'voice', 'system'], default: 'text' })
  type: 'text' | 'image' | 'video' | 'file' | 'voice' | 'system';

  @Prop({ default: '' })
  content: string;

  @Prop({ default: false })
  isEdited: boolean;

  @Prop({ type: Date, default: null })
  editedAt: Date | null;

  @Prop({ type: [Attachment], default: [] })
  attachments: Attachment[];

  @Prop({ type: [String], default: [] })
  deletedFor: string[];

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  @Prop({ type: ForwardInfo, default: null })
  forwardedFrom: ForwardInfo | null;

  @Prop({ type: ReplyInfo, default: null })
  replyTo: ReplyInfo | null;

  @Prop({ type: [Reaction], default: [] })
  reactions: Reaction[];

  @Prop({ type: [ReadReceipt], default: [] })
  readBy: ReadReceipt[];

  createdAt: Date;
  updatedAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Compound index: paginate messages in a conversation by creation time
MessageSchema.index({ conversationId: 1, createdAt: -1 });
// Index for pinned messages lookup
MessageSchema.index({ conversationId: 1, 'reactions.userId': 1 });
