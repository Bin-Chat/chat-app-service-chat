/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { CHAT_EVENTS } from '../kafka/events/chat.events';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

import { AddPollOptionDto } from './dto/add-poll-option.dto';
import { CreatePollDto } from './dto/create-poll.dto';
import { UpdatePollOptionDto } from './dto/update-poll-option.dto';
import { UpdatePollDto } from './dto/update-poll.dto';
import { VotePollDto } from './dto/vote-poll.dto';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import { Poll, PollDocument } from './schemas/poll.schema';

@Injectable()
export class PollService {
  private readonly logger = new Logger(PollService.name);

  constructor(
    @InjectModel(Poll.name) private pollModel: Model<PollDocument>,
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    private kafkaProducer: KafkaProducerService
  ) {}

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async ensureParticipant(userId: string, conversationId: string) {
    const conv = await this.conversationModel
      .findOne({ _id: new Types.ObjectId(conversationId), 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');
    return conv;
  }

  private async ensurePollParticipant(userId: string, pollId: string) {
    const poll = await this.pollModel.findById(pollId);
    if (!poll) throw new NotFoundException('Bình chọn không tồn tại');
    const conv = await this.conversationModel
      .findOne({ _id: poll.conversationId, 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');
    return { poll, conv };
  }

  private isOwnerOrAdmin(conv: any, userId: string): boolean {
    const p = (conv.participants ?? []).find((x: any) => x.userId === userId);
    return p?.role === 'owner' || p?.role === 'admin';
  }

  private async emitPollEvent(eventKey: string, conv: any, payload: Record<string, unknown>) {
    try {
      const participantIds = (conv?.participants ?? []).map((p: any) => p.userId);
      await this.kafkaProducer.emit(eventKey, { ...payload, participantIds });
    } catch (err) {
      this.logger.warn(`Failed to emit ${eventKey}: ${(err as Error).message}`);
    }
  }

  /**
   * Build the user-facing poll view (respects hideResultsUntilVoted, hideVoters).
   */
  private buildPollView(poll: PollDocument | Poll, requestingUserId: string): any {
    const p: any = (poll as any).toObject ? (poll as any).toObject() : poll;
    const myVote = p.votes.find((v: any) => v.userId === requestingUserId);
    const myVotes: string[] = myVote ? myVote.optionIds.map((id: any) => id.toString()) : [];

    const totalVoters = p.votes.filter((v: any) => v.optionIds.length > 0).length;

    const now = new Date();
    const isExpired = p.expiresAt ? new Date(p.expiresAt) <= now : false;
    const isClosed = !!p.closedAt;

    const isCreator = p.createdBy === requestingUserId;
    const canSeeResults = !p.hideResultsUntilVoted || isCreator || isClosed || isExpired;

    const options = p.options.map((opt: any) => {
      const optId = opt._id.toString();
      const voters = p.votes
        .filter((v: any) => v.optionIds.some((id: any) => id.toString() === optId))
        .map((v: any) => v.userId);
      return {
        _id: optId,
        text: opt.text,
        addedBy: opt.addedBy,
        voteCount: canSeeResults ? voters.length : 0,
        voters: canSeeResults && !p.hideVoters ? voters : [],
      };
    });

    return {
      _id: p._id.toString(),
      conversationId: p.conversationId.toString(),
      messageId: p.messageId.toString(),
      createdBy: p.createdBy,
      question: p.question,
      options,
      totalVoters: canSeeResults ? totalVoters : 0,
      myVotes,
      allowMultiple: p.allowMultiple,
      allowAddOptions: p.allowAddOptions,
      hideResultsUntilVoted: p.hideResultsUntilVoted,
      hideVoters: p.hideVoters,
      isClosed,
      isExpired,
      expiresAt: p.expiresAt,
      closedAt: p.closedAt,
      canSeeResults,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async createPoll(userId: string, conversationId: string, dto: CreatePollDto, actorName = '') {
    const conv = await this.ensureParticipant(userId, conversationId);

    const trimmedQuestion = dto.question.trim();
    if (!trimmedQuestion) throw new BadRequestException('Chủ đề bình chọn không được trống');

    const cleanOptions = dto.options.map((o) => (o ?? '').trim()).filter((o) => o.length > 0);
    if (cleanOptions.length < 2) throw new BadRequestException('Phải có ít nhất 2 phương án');

    const dedupSet = new Set(cleanOptions.map((o) => o.toLowerCase()));
    if (dedupSet.size !== cleanOptions.length)
      throw new BadRequestException('Các phương án không được trùng nhau');

    if (cleanOptions.some((o) => o.length > 100))
      throw new BadRequestException('Mỗi phương án tối đa 100 ký tự');

    if (dto.expiresAt) {
      const exp = new Date(dto.expiresAt);
      if (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now())
        throw new BadRequestException('Thời hạn không hợp lệ');
    }

    // 1. Create message first (we need its _id to link)
    const conversationObjectId = new Types.ObjectId(conversationId);
    const msg = await this.messageModel.create({
      conversationId: conversationObjectId,
      senderId: userId,
      type: 'poll',
      content: trimmedQuestion,
      attachments: [],
      metadata: null, // will be patched after poll create
    });

    // 2. Create poll doc
    const poll = await this.pollModel.create({
      conversationId: conversationObjectId,
      messageId: msg._id,
      createdBy: userId,
      question: trimmedQuestion,
      options: cleanOptions.map((text) => ({
        _id: new Types.ObjectId(),
        text,
        addedBy: userId,
        createdAt: new Date(),
      })),
      votes: [],
      allowMultiple: dto.allowMultiple ?? false,
      allowAddOptions: dto.allowAddOptions ?? false,
      hideResultsUntilVoted: dto.hideResultsUntilVoted ?? false,
      hideVoters: dto.hideVoters ?? false,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      closedAt: null,
    });

    const pollView = this.buildPollView(poll, userId);

    // 3. Patch message metadata with poll info
    msg.metadata = { type: 'poll', pollId: pollView._id, poll: pollView };
    await msg.save();

    // 4. Update conversation lastMessage
    const lastMessagePreview = `📊 ${trimmedQuestion}`;
    await this.conversationModel.updateOne(
      { _id: conversationObjectId },
      {
        lastMessage: {
          senderId: userId,
          content: lastMessagePreview,
          type: 'poll',
          sentAt: msg.createdAt,
        },
      }
    );

    // 5. Emit MESSAGE_CREATED so message:new flows to all clients via the standard pipeline
    try {
      const participantIds = (conv.participants ?? []).map((p: any) => p.userId);
      await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_CREATED, {
        messageId: (msg._id as any).toString(),
        conversationId,
        senderId: userId,
        participants: participantIds,
        content: trimmedQuestion,
        type: 'poll',
        metadata: msg.metadata,
        attachments: [],
        createdAt: msg.createdAt,
      });
    } catch (err) {
      this.logger.warn(`Failed to emit MESSAGE_CREATED for poll: ${(err as Error).message}`);
    }

    // 6. Emit POLL_CREATED for any extra side-channel handlers
    await this.emitPollEvent(CHAT_EVENTS.POLL_CREATED, conv, {
      pollId: pollView._id,
      messageId: (msg._id as any).toString(),
      conversationId,
      poll: pollView,
      actorName,
    });

    return { poll: pollView, messageId: (msg._id as any).toString() };
  }

  async getPoll(userId: string, pollId: string) {
    const { poll } = await this.ensurePollParticipant(userId, pollId);
    return this.buildPollView(poll, userId);
  }

  async getPollsByConversation(userId: string, conversationId: string) {
    await this.ensureParticipant(userId, conversationId);
    const polls = await this.pollModel
      .find({ conversationId: new Types.ObjectId(conversationId) })
      .sort({ createdAt: -1 })
      .lean();
    return polls.map((p) => this.buildPollView(p as any, userId));
  }

  async vote(userId: string, pollId: string, dto: VotePollDto) {
    const { poll, conv } = await this.ensurePollParticipant(userId, pollId);

    if (poll.closedAt) throw new BadRequestException('Bình chọn đã kết thúc');
    if (poll.expiresAt && new Date(poll.expiresAt) <= new Date())
      throw new BadRequestException('Bình chọn đã hết hạn');

    const validOptionIdSet = new Set(poll.options.map((o: any) => o._id.toString()));
    const requested = (dto.optionIds ?? []).filter((id) => validOptionIdSet.has(id));

    if (requested.length === 0 && (dto.optionIds ?? []).length > 0)
      throw new BadRequestException('Phương án không hợp lệ');

    if (!poll.allowMultiple && requested.length > 1)
      throw new BadRequestException('Bình chọn này chỉ cho phép chọn 1 phương án');

    const objectIds = requested.map((id) => new Types.ObjectId(id));

    const existingIdx = poll.votes.findIndex((v: any) => v.userId === userId);
    if (existingIdx >= 0) {
      if (objectIds.length === 0) {
        poll.votes.splice(existingIdx, 1);
      } else {
        poll.votes[existingIdx].optionIds = objectIds;
        poll.votes[existingIdx].votedAt = new Date();
      }
    } else if (objectIds.length > 0) {
      poll.votes.push({ userId, optionIds: objectIds, votedAt: new Date() } as any);
    }

    await poll.save();

    const pollView = this.buildPollView(poll, userId);

    // Canonical view (myVotes=[]) is broadcast to all participants so each client
    // derives their own votes from opt.voters — prevents cross-user myVotes pollution.
    let canonicalView: any;
    try {
      canonicalView = this.buildPollView(poll, '__broadcast__');
      await this.messageModel.updateOne(
        { _id: poll.messageId },
        { $set: { 'metadata.poll': canonicalView } }
      );
    } catch (err) {
      this.logger.warn(`Failed to patch message metadata: ${(err as Error).message}`);
      canonicalView = this.buildPollView(poll, '__broadcast__');
    }

    await this.emitPollEvent(CHAT_EVENTS.POLL_VOTED, conv, {
      pollId,
      messageId: poll.messageId.toString(),
      conversationId: poll.conversationId.toString(),
      poll: canonicalView, // broadcast canonical; clients derive own myVotes from opt.voters
    });

    return pollView;
  }

  async addOption(userId: string, pollId: string, dto: AddPollOptionDto) {
    const { poll, conv } = await this.ensurePollParticipant(userId, pollId);

    if (poll.closedAt) throw new BadRequestException('Bình chọn đã kết thúc');
    if (poll.expiresAt && new Date(poll.expiresAt) <= new Date())
      throw new BadRequestException('Bình chọn đã hết hạn');

    const isCreatorOrAdmin = poll.createdBy === userId || this.isOwnerOrAdmin(conv, userId);
    if (!poll.allowAddOptions && !isCreatorOrAdmin)
      throw new ForbiddenException('Bình chọn này không cho phép thêm phương án');

    if (poll.options.length >= 20) throw new BadRequestException('Bình chọn tối đa 20 phương án');

    const text = dto.text.trim();
    if (!text) throw new BadRequestException('Phương án không được trống');
    if (text.length > 100) throw new BadRequestException('Phương án tối đa 100 ký tự');

    const dup = poll.options.find((o: any) => o.text.toLowerCase() === text.toLowerCase());
    if (dup) throw new BadRequestException('Phương án đã tồn tại');

    poll.options.push({
      _id: new Types.ObjectId(),
      text,
      addedBy: userId,
      createdAt: new Date(),
    } as any);
    await poll.save();

    const pollView = this.buildPollView(poll, userId);
    try {
      await this.messageModel.updateOne(
        { _id: poll.messageId },
        { $set: { 'metadata.poll': pollView } }
      );
    } catch {
      /* no-op */
    }

    await this.emitPollEvent(CHAT_EVENTS.POLL_OPTION_ADDED, conv, {
      pollId,
      messageId: poll.messageId.toString(),
      conversationId: poll.conversationId.toString(),
      poll: pollView,
    });

    return pollView;
  }

  async updatePoll(userId: string, pollId: string, dto: UpdatePollDto) {
    const { poll, conv } = await this.ensurePollParticipant(userId, pollId);

    if (poll.createdBy !== userId)
      throw new ForbiddenException('Chỉ người tạo mới có thể chỉnh sửa bình chọn');
    if (poll.closedAt) throw new BadRequestException('Bình chọn đã kết thúc');
    if (poll.expiresAt && new Date(poll.expiresAt) <= new Date())
      throw new BadRequestException('Bình chọn đã hết hạn');

    if (dto.question !== undefined) {
      const trimmed = dto.question.trim();
      if (!trimmed) throw new BadRequestException('Chủ đề không được trống');
      poll.question = trimmed;
    }

    await poll.save();

    const pollView = this.buildPollView(poll, userId);
    try {
      const canonicalView = this.buildPollView(poll, '__broadcast__');
      await this.messageModel.updateOne(
        { _id: poll.messageId },
        { $set: { 'metadata.poll': canonicalView, content: poll.question } }
      );
    } catch {
      /* no-op */
    }

    await this.emitPollEvent(CHAT_EVENTS.POLL_UPDATED, conv, {
      pollId,
      messageId: poll.messageId.toString(),
      conversationId: poll.conversationId.toString(),
      poll: pollView,
    });

    return pollView;
  }

  async updateOption(userId: string, pollId: string, optionId: string, dto: UpdatePollOptionDto) {
    const { poll, conv } = await this.ensurePollParticipant(userId, pollId);

    if (poll.createdBy !== userId)
      throw new ForbiddenException('Chỉ người tạo mới có thể sửa phương án');
    if (poll.closedAt) throw new BadRequestException('Bình chọn đã kết thúc');
    if (poll.expiresAt && new Date(poll.expiresAt) <= new Date())
      throw new BadRequestException('Bình chọn đã hết hạn');

    const optIdx = poll.options.findIndex((o: any) => o._id.toString() === optionId);
    if (optIdx < 0) throw new NotFoundException('Phương án không tồn tại');

    const text = dto.text.trim();
    if (!text) throw new BadRequestException('Phương án không được trống');
    if (text.length > 100) throw new BadRequestException('Phương án tối đa 100 ký tự');

    const dup = poll.options.find(
      (o: any, i: number) => i !== optIdx && o.text.toLowerCase() === text.toLowerCase()
    );
    if (dup) throw new BadRequestException('Phương án đã tồn tại');

    (poll.options[optIdx] as any).text = text;
    await poll.save();

    const pollView = this.buildPollView(poll, userId);
    try {
      const canonicalView = this.buildPollView(poll, '__broadcast__');
      await this.messageModel.updateOne(
        { _id: poll.messageId },
        { $set: { 'metadata.poll': canonicalView } }
      );
    } catch {
      /* no-op */
    }

    await this.emitPollEvent(CHAT_EVENTS.POLL_UPDATED, conv, {
      pollId,
      messageId: poll.messageId.toString(),
      conversationId: poll.conversationId.toString(),
      poll: pollView,
    });

    return pollView;
  }

  async deleteOption(userId: string, pollId: string, optionId: string) {
    const { poll, conv } = await this.ensurePollParticipant(userId, pollId);

    if (poll.createdBy !== userId)
      throw new ForbiddenException('Chỉ người tạo mới có thể xóa phương án');
    if (poll.closedAt) throw new BadRequestException('Bình chọn đã kết thúc');
    if (poll.expiresAt && new Date(poll.expiresAt) <= new Date())
      throw new BadRequestException('Bình chọn đã hết hạn');
    if (poll.options.length <= 2)
      throw new BadRequestException('Bình chọn phải có ít nhất 2 phương án');

    const hasVotes = poll.votes.some((v: any) =>
      v.optionIds.some((id: any) => id.toString() === optionId)
    );
    if (hasVotes) throw new BadRequestException('Không thể xóa phương án đã có người bình chọn');

    poll.options = poll.options.filter((o: any) => o._id.toString() !== optionId) as any;
    await poll.save();

    const pollView = this.buildPollView(poll, userId);
    try {
      const canonicalView = this.buildPollView(poll, '__broadcast__');
      await this.messageModel.updateOne(
        { _id: poll.messageId },
        { $set: { 'metadata.poll': canonicalView } }
      );
    } catch {
      /* no-op */
    }

    await this.emitPollEvent(CHAT_EVENTS.POLL_UPDATED, conv, {
      pollId,
      messageId: poll.messageId.toString(),
      conversationId: poll.conversationId.toString(),
      poll: pollView,
    });

    return pollView;
  }

  async closePoll(userId: string, pollId: string) {
    const { poll, conv } = await this.ensurePollParticipant(userId, pollId);

    const isCreatorOrAdmin = poll.createdBy === userId || this.isOwnerOrAdmin(conv, userId);
    if (!isCreatorOrAdmin) throw new ForbiddenException('Bạn không có quyền kết thúc bình chọn');

    if (poll.closedAt) return this.buildPollView(poll, userId);

    poll.closedAt = new Date();
    await poll.save();

    const pollView = this.buildPollView(poll, userId);
    try {
      await this.messageModel.updateOne(
        { _id: poll.messageId },
        { $set: { 'metadata.poll': pollView } }
      );
    } catch {
      /* no-op */
    }

    await this.emitPollEvent(CHAT_EVENTS.POLL_CLOSED, conv, {
      pollId,
      messageId: poll.messageId.toString(),
      conversationId: poll.conversationId.toString(),
      poll: pollView,
    });

    return pollView;
  }

  async deletePoll(userId: string, pollId: string) {
    const { poll, conv } = await this.ensurePollParticipant(userId, pollId);

    const isCreatorOrAdmin = poll.createdBy === userId || this.isOwnerOrAdmin(conv, userId);
    if (!isCreatorOrAdmin) throw new ForbiddenException('Bạn không có quyền xóa bình chọn');

    const messageId = poll.messageId.toString();
    const conversationId = poll.conversationId.toString();

    await this.pollModel.deleteOne({ _id: poll._id });

    // Revoke the corresponding message
    try {
      await this.messageModel.updateOne(
        { _id: poll.messageId },
        { $set: { revokedAt: new Date() } }
      );
    } catch {
      /* no-op */
    }

    await this.emitPollEvent(CHAT_EVENTS.POLL_DELETED, conv, {
      pollId,
      messageId,
      conversationId,
    });

    return { success: true };
  }
}
