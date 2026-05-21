import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: true })
export class PollOption {
  _id: Types.ObjectId;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true })
  addedBy: string; // userId

  @Prop({ default: () => new Date() })
  createdAt: Date;
}

export const PollOptionSchema = SchemaFactory.createForClass(PollOption);

@Schema({ _id: false })
export class PollVote {
  @Prop({ required: true })
  userId: string;

  @Prop({ type: [Types.ObjectId], default: [] })
  optionIds: Types.ObjectId[];

  @Prop({ default: () => new Date() })
  votedAt: Date;
}

export const PollVoteSchema = SchemaFactory.createForClass(PollVote);

export type PollDocument = Poll & Document;

@Schema({ timestamps: true, collection: 'polls' })
export class Poll {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true, index: true })
  conversationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Message', required: true, index: true })
  messageId: Types.ObjectId;

  @Prop({ required: true })
  createdBy: string;

  @Prop({ required: true })
  question: string;

  @Prop({ type: [PollOptionSchema], default: [] })
  options: PollOption[];

  @Prop({ type: [PollVoteSchema], default: [] })
  votes: PollVote[];

  @Prop({ default: false })
  allowMultiple: boolean;

  @Prop({ default: false })
  allowAddOptions: boolean;

  @Prop({ default: false })
  hideResultsUntilVoted: boolean;

  @Prop({ default: false })
  hideVoters: boolean;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  @Prop({ type: Date, default: null })
  closedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const PollSchema = SchemaFactory.createForClass(Poll);

PollSchema.index({ conversationId: 1, createdAt: -1 });
