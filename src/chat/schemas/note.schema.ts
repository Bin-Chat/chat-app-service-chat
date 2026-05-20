import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NoteDocument = Note & Document;

@Schema({ timestamps: true, collection: 'notes' })
export class Note {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true, index: true })
  conversationId: Types.ObjectId;

  @Prop({ required: true })
  createdBy: string; // userId string

  @Prop({ required: true })
  content: string;

  @Prop({ default: false })
  isPinned: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const NoteSchema = SchemaFactory.createForClass(Note);

// Index for efficient list-by-conversation queries (pinned first, then most recent)
NoteSchema.index({ conversationId: 1, isPinned: -1, createdAt: -1 });
