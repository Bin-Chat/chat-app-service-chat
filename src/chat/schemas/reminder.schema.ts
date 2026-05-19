import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReminderDocument = Reminder & Document;

export type RepeatType = 'none' | 'daily' | 'weekly' | 'monthly';

@Schema({ _id: false })
export class ReminderRsvp {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, enum: ['yes', 'no'] })
  status: 'yes' | 'no';
}

@Schema({ timestamps: true })
export class Reminder {
  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true, index: true })
  conversationId: Types.ObjectId;

  @Prop({ required: true })
  createdBy: string; // userId string

  @Prop({ required: true })
  content: string;

  @Prop({ required: true })
  remindAt: Date;

  @Prop({ enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' })
  repeat: RepeatType;

  @Prop({ default: false })
  isCompleted: boolean;

  @Prop({ type: Date, default: null })
  lastFiredAt: Date | null;

  @Prop({ type: [ReminderRsvp], default: [] })
  rsvps: ReminderRsvp[];
}

export const ReminderSchema = SchemaFactory.createForClass(Reminder);

// Compound index for efficient cron queries
ReminderSchema.index({ conversationId: 1, isCompleted: 1, remindAt: 1 });
