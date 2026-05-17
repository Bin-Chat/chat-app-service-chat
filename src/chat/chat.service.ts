import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import { CHAT_EVENTS } from '../kafka/events/chat.events';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

import { AddMembersDto } from './dto/add-members.dto';
import { BanMemberDto } from './dto/ban-member.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { TransferOwnerDto } from './dto/transfer-owner.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { UpdateMySettingsDto } from './dto/update-my-settings.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { checkGroupRole } from './guards/group-role.guard';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';

const REVOKE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const EDIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ADMINS = 5;
const MAX_PINNED_MESSAGES = 50;

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    private kafkaProducer: KafkaProducerService
  ) {}

  // ── Conversations ─────────────────────────────────────────────────────────

  async createConversation(userId: string, dto: CreateConversationDto) {
    const allParticipantIds = Array.from(new Set([userId, ...dto.participantIds]));

    // For direct chats, check if conversation already exists (idempotent)
    if (dto.type === 'direct') {
      if (allParticipantIds.length !== 2) {
        throw new BadRequestException('Direct conversation phải có đúng 2 người');
      }

      const existing = await this.conversationModel.findOne({
        type: 'direct',
        'participants.userId': { $all: allParticipantIds },
        $expr: { $eq: [{ $size: '$participants' }, 2] },
      });

      if (existing) return existing;
    }

    // For group chats, require a name and at least 2 other members
    if (dto.type === 'group') {
      if (!dto.name?.trim()) {
        throw new BadRequestException('Nhóm phải có tên');
      }
      if (allParticipantIds.length < 3) {
        throw new BadRequestException('Nhóm phải có ít nhất 3 thành viên');
      }
    }

    const now = new Date();
    const participants = allParticipantIds.map((id) => ({
      userId: id,
      role: dto.type === 'group' && id === userId ? 'owner' : 'member',
      joinedAt: now,
    }));

    const conversation = await this.conversationModel.create({
      type: dto.type,
      name: dto.name,
      participants,
    });

    // Notify other participants about the new group so their UI updates in real-time
    if (dto.type === 'group') {
      const otherMemberIds = allParticipantIds.filter((id) => id !== userId);
      await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_MEMBERS_ADDED, {
        conversationId: conversation._id.toString(),
        addedBy: userId,
        newMemberIds: otherMemberIds,
        participants: allParticipantIds,
      });
    }

    return conversation;
  }

  async getConversations(userId: string) {
    return this.conversationModel
      .find({ 'participants.userId': userId })
      .sort({ 'lastMessage.sentAt': -1, updatedAt: -1 })
      .lean();
  }

  async getConversation(userId: string, conversationId: string) {
    const conv = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        'participants.userId': userId,
      })
      .lean();

    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại');
    return conv;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async getMessages(userId: string, conversationId: string, cursor?: string, limit = 30) {
    const conv = await this.ensureParticipant(userId, conversationId);

    const filter: FilterQuery<MessageDocument> = {
      conversationId: conv._id,
      deletedFor: { $ne: userId },
    };

    if (cursor) {
      const cursorDate = Array.isArray(cursor) ? new Date(cursor[0]) : new Date(cursor);
      if (isNaN(cursorDate.getTime())) {
        throw new BadRequestException('cursor không hợp lệ, phải là ISO date string');
      }
      filter.createdAt = { $lt: cursorDate };
    }

    const messages = await this.messageModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    return { messages, hasMore };
  }

  async sendMessage(userId: string, conversationId: string, dto: SendMessageDto) {
    const conv = await this.ensureParticipant(userId, conversationId);

    // Check if user is banned (system messages bypass this check)
    const participant = conv.participants.find((p) => p.userId === userId);
    if (dto.type !== 'system' && participant?.isBanned) {
      const bannedUntil = participant.bannedUntil;
      if (!bannedUntil || bannedUntil > new Date()) {
        throw new ForbiddenException('Bạn đã bị cấm gửi tin nhắn trong nhóm này');
      }
      // Ban expired — auto-unban
      await this.conversationModel.updateOne(
        { _id: conv._id, 'participants.userId': userId },
        { $set: { 'participants.$.isBanned': false, 'participants.$.bannedUntil': null } }
      );
    }

    // Check onlyAdminCanSend setting for group chats (system messages bypass this check)
    if (dto.type !== 'system' && conv.type === 'group' && conv.settings?.onlyAdminCanSend) {
      const role = participant?.role;
      if (role !== 'owner' && role !== 'admin') {
        throw new ForbiddenException('Chỉ admin mới được gửi tin nhắn trong nhóm này');
      }
    }

    if (
      dto.type !== 'system' &&
      !dto.content?.trim() &&
      (!dto.attachments || dto.attachments.length === 0)
    ) {
      throw new BadRequestException('Tin nhắn phải có nội dung hoặc file đính kèm');
    }

    const message = await this.messageModel.create({
      conversationId: conv._id,
      senderId: userId,
      type: dto.type || 'text',
      content: dto.content?.trim() || '',
      attachments: dto.attachments || [],
      replyTo: dto.replyTo ?? null,
    });

    // Update lastMessage on conversation
    const participantIds = conv.participants.map((p) => p.userId);
    const msgType = message.type || 'text';
    const lastMessage = {
      messageId: message._id.toString(),
      senderId: userId,
      content: dto.content?.trim() || (dto.attachments?.length ? '[File]' : ''),
      type: msgType,
      sentAt: message.createdAt,
      revokedAt: null,
    };

    await this.conversationModel.updateOne({ _id: conv._id }, { lastMessage });

    // Emit Kafka events
    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_CREATED, {
      messageId: message._id.toString(),
      conversationId: conv._id.toString(),
      senderId: userId,
      participants: participantIds,
      content: message.content,
      type: msgType,
      attachments: message.attachments,
      replyTo: message.replyTo ?? null,
      createdAt: message.createdAt,
    });

    await this.kafkaProducer.emit(CHAT_EVENTS.CONVERSATION_UPDATED, {
      conversationId: conv._id.toString(),
      participants: participantIds,
      lastMessage,
    });

    return message;
  }

  async revokeMessage(userId: string, messageId: string) {
    const message = await this.messageModel.findById(messageId);
    if (!message) throw new NotFoundException('Tin nhắn không tồn tại');
    if (message.senderId !== userId)
      throw new ForbiddenException('Chỉ người gửi mới có thể thu hồi');
    if (message.revokedAt) throw new BadRequestException('Tin nhắn đã được thu hồi');

    const elapsed = Date.now() - message.createdAt.getTime();
    if (elapsed > REVOKE_WINDOW_MS) {
      throw new BadRequestException('Chỉ có thể thu hồi tin nhắn trong vòng 24 giờ');
    }

    message.revokedAt = new Date();
    await message.save();

    const conv = await this.conversationModel.findById(message.conversationId);
    const participantIds = conv?.participants.map((p) => p.userId) || [];

    // Update conv.lastMessage.revokedAt if this was the last message
    if (conv?.lastMessage?.messageId === message._id.toString()) {
      await this.conversationModel.updateOne(
        { _id: message.conversationId },
        { $set: { 'lastMessage.revokedAt': message.revokedAt } }
      );
    }

    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_REVOKED, {
      messageId: message._id.toString(),
      conversationId: message.conversationId.toString(),
      senderId: userId,
      participants: participantIds,
      revokedAt: message.revokedAt,
      revokedBy: 'user',
      attachmentUrls: message.attachments?.map((a) => a.url) ?? [],
    });

    return { success: true };
  }

  async deleteMessage(userId: string, messageId: string) {
    const message = await this.messageModel.findById(messageId);
    if (!message) throw new NotFoundException('Tin nhắn không tồn tại');

    // Verify user is participant
    await this.ensureParticipant(userId, message.conversationId.toString());

    // Soft delete — only hide for this user
    await this.messageModel.updateOne({ _id: message._id }, { $addToSet: { deletedFor: userId } });

    return { success: true };
  }

  async forwardMessage(userId: string, messageId: string, dto: ForwardMessageDto) {
    const original = await this.messageModel.findById(messageId).lean();
    if (!original) throw new NotFoundException('Tin nhắn gốc không tồn tại');
    if (original.revokedAt)
      throw new BadRequestException('Không thể chuyển tiếp tin nhắn đã thu hồi');

    // Ensure user is participant in source conversation
    await this.ensureParticipant(userId, original.conversationId.toString());
    // Ensure user is participant in target conversation
    const targetConv = await this.ensureParticipant(userId, dto.targetConversationId);

    const forwarded = await this.messageModel.create({
      conversationId: targetConv._id,
      senderId: userId,
      content: original.content,
      attachments: original.attachments,
      forwardedFrom: {
        messageId: original._id.toString(),
        conversationId: original.conversationId.toString(),
        senderId: original.senderId,
      },
    });

    // Update lastMessage on target conversation
    const participantIds = targetConv.participants.map((p) => p.userId);
    const lastMessage = {
      senderId: userId,
      content: original.content || '[File]',
      type: original.attachments?.length ? original.attachments[0].type : 'text',
      sentAt: forwarded.createdAt,
    };

    await this.conversationModel.updateOne({ _id: targetConv._id }, { lastMessage });

    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_CREATED, {
      messageId: forwarded._id.toString(),
      conversationId: targetConv._id.toString(),
      senderId: userId,
      participants: participantIds,
      content: forwarded.content,
      type: lastMessage.type,
      attachments: forwarded.attachments,
      createdAt: forwarded.createdAt,
    });

    await this.kafkaProducer.emit(CHAT_EVENTS.CONVERSATION_UPDATED, {
      conversationId: targetConv._id.toString(),
      participants: participantIds,
      lastMessage,
    });

    return forwarded;
  }

  async toggleReaction(userId: string, messageId: string, dto: ReactMessageDto) {
    const message = await this.messageModel.findById(messageId);
    if (!message) throw new NotFoundException('Tin nhắn không tồn tại');
    if (message.revokedAt) throw new BadRequestException('Không thể react tin nhắn đã thu hồi');

    await this.ensureParticipant(userId, message.conversationId.toString());

    const existingIndex = message.reactions.findIndex(
      (r) => r.userId === userId && r.emoji === dto.emoji
    );

    let action: 'added' | 'removed';

    if (existingIndex >= 0) {
      // Same emoji → toggle off (remove)
      message.reactions.splice(existingIndex, 1);
      action = 'removed';
    } else {
      // Different emoji or no reaction → replace (1 per user rule)
      const oldIndex = message.reactions.findIndex((r) => r.userId === userId);
      if (oldIndex >= 0) {
        message.reactions.splice(oldIndex, 1);
      }
      message.reactions.push({ userId, emoji: dto.emoji });
      action = 'added';
    }

    await message.save();

    const conv = await this.conversationModel.findById(message.conversationId);
    const participantIds = conv?.participants.map((p) => p.userId) || [];

    await this.kafkaProducer.emit(CHAT_EVENTS.REACTION_TOGGLED, {
      messageId: message._id.toString(),
      conversationId: message.conversationId.toString(),
      participants: participantIds,
      userId,
      emoji: dto.emoji,
      action,
    });

    return { reactions: message.reactions, action };
  }

  // ── Group Management ───────────────────────────────────────────────────

  async getGroupMembers(userId: string, conversationId: string) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    return conv.participants;
  }

  async addMembers(userId: string, conversationId: string, dto: AddMembersDto, actorName = '') {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    const actor = checkGroupRole(conv.participants, userId, ['owner', 'admin', 'member']);

    // Members can only add if allowMemberInvite setting is enabled; admins/owners always can
    if (actor.role === 'member' && !conv.settings?.allowMemberInvite) {
      throw new ForbiddenException('Chỉ admin mới có thể thêm thành viên vào nhóm này');
    }

    const existingIds = new Set(conv.participants.map((p) => p.userId));
    const newIds = dto.memberIds.filter((id) => !existingIds.has(id));
    if (newIds.length === 0) {
      throw new BadRequestException('Tất cả thành viên đã có trong nhóm');
    }

    const now = new Date();
    const newParticipants = newIds.map((id) => ({ userId: id, role: 'member', joinedAt: now }));

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $push: { participants: { $each: newParticipants } } }
    );

    // System message
    await this.insertSystemMessage(
      conv._id,
      `${actorName || '—'} đã thêm ${newIds.length} thành viên vào nhóm`
    );

    const allParticipantIds = [...Array.from(existingIds), ...newIds];
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_MEMBERS_ADDED, {
      conversationId: conv._id.toString(),
      addedBy: userId,
      newMemberIds: newIds,
      participants: allParticipantIds,
    });

    return { success: true, addedCount: newIds.length };
  }

  async removeMember(userId: string, conversationId: string, memberId: string, actorName = '') {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    const actor = checkGroupRole(conv.participants, userId, ['owner', 'admin']);

    if (memberId === userId) {
      throw new BadRequestException('Dùng chức năng rời nhóm thay vì tự xoá mình');
    }

    const target = conv.participants.find((p) => p.userId === memberId);
    if (!target) {
      throw new BadRequestException('Thành viên không có trong nhóm');
    }

    // Admin cannot remove owner or other admins
    if (actor.role === 'admin' && (target.role === 'owner' || target.role === 'admin')) {
      throw new ForbiddenException('Phó nhóm không thể xoá Chủ nhóm hoặc Phó nhóm khác');
    }

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $pull: { participants: { userId: memberId } } }
    );

    await this.insertSystemMessage(conv._id, `${actorName || '—'} đã xóa một thành viên khỏi nhóm`);

    const remainingIds = conv.participants
      .filter((p) => p.userId !== memberId)
      .map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_MEMBER_REMOVED, {
      conversationId: conv._id.toString(),
      removedBy: userId,
      removedMemberId: memberId,
      participants: [...remainingIds, memberId], // notify removed member too
    });

    return { success: true };
  }

  async leaveGroup(userId: string, conversationId: string, actorName = '') {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    const actor = conv.participants.find((p) => p.userId === userId);

    if (actor?.role === 'owner') {
      throw new BadRequestException(
        'Chủ nhóm phải chuyển quyền trước khi rời nhóm. Dùng API chuyển quyền chủ nhóm.'
      );
    }

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $pull: { participants: { userId } } }
    );

    await this.insertSystemMessage(conv._id, `${actorName || '—'} đã rời khỏi nhóm`);

    const remainingIds = conv.participants.filter((p) => p.userId !== userId).map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_MEMBER_LEFT, {
      conversationId: conv._id.toString(),
      userId,
      participants: [...remainingIds, userId],
    });

    return { success: true };
  }

  async updateGroup(userId: string, conversationId: string, dto: UpdateGroupDto, actorName = '') {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner', 'admin']);

    const updates: Record<string, string> = {};
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.avatar !== undefined) updates.avatar = dto.avatar;
    if (dto.description !== undefined) updates.description = dto.description;

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('Không có thay đổi nào');
    }

    await this.conversationModel.updateOne({ _id: conv._id }, { $set: updates });

    await this.insertSystemMessage(conv._id, `${actorName || '—'} đã cập nhật thông tin nhóm`);

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_UPDATED, {
      conversationId: conv._id.toString(),
      updatedBy: userId,
      changes: updates,
      participants: participantIds,
    });

    return { success: true, ...updates };
  }

  async changeRole(userId: string, conversationId: string, dto: ChangeRoleDto, actorName = '') {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner']);

    const target = conv.participants.find((p) => p.userId === dto.memberId);
    if (!target) {
      throw new BadRequestException('Thành viên không có trong nhóm');
    }
    if (target.role === 'owner') {
      throw new BadRequestException('Không thể thay đổi quyền Chủ nhóm bằng API này');
    }

    // Enforce max 5 admins per group
    if (dto.role === 'admin') {
      const currentAdminCount = conv.participants.filter((p) => p.role === 'admin').length;
      if (currentAdminCount >= MAX_ADMINS) {
        throw new BadRequestException(`Nhóm chỉ được tối đa ${MAX_ADMINS} phó nhóm`);
      }
    }

    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': dto.memberId },
      { $set: { 'participants.$.role': dto.role } }
    );

    const roleName = dto.role === 'admin' ? 'Phó nhóm' : 'Thành viên';
    await this.insertSystemMessage(
      conv._id,
      `${actorName || '—'} đã đặt một thành viên làm ${roleName}`
    );

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_ROLE_CHANGED, {
      conversationId: conv._id.toString(),
      changedBy: userId,
      memberId: dto.memberId,
      newRole: dto.role,
      participants: participantIds,
    });

    return { success: true };
  }

  async transferOwnership(
    userId: string,
    conversationId: string,
    dto: TransferOwnerDto,
    actorName = ''
  ) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner']);

    const target = conv.participants.find((p) => p.userId === dto.newOwnerId);
    if (!target) {
      throw new BadRequestException('Người nhận quyền không có trong nhóm');
    }
    if (target.userId === userId) {
      throw new BadRequestException('Bạn đã là Chủ nhóm');
    }

    // Demote current owner to admin, promote new owner
    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': userId },
      { $set: { 'participants.$.role': 'admin' } }
    );
    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': dto.newOwnerId },
      { $set: { 'participants.$.role': 'owner' } }
    );

    await this.insertSystemMessage(conv._id, `${actorName || '—'} đã chuyển quyền Chủ nhóm`);

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_OWNER_TRANSFERRED, {
      conversationId: conv._id.toString(),
      oldOwnerId: userId,
      newOwnerId: dto.newOwnerId,
      participants: participantIds,
    });

    return { success: true };
  }

  async dissolveGroup(userId: string, conversationId: string) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner']);

    const participantIds = conv.participants.map((p) => p.userId);

    // Delete all messages and the conversation
    await this.messageModel.deleteMany({ conversationId: conv._id });
    await this.conversationModel.deleteOne({ _id: conv._id });

    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_DISSOLVED, {
      conversationId: conv._id.toString(),
      dissolvedBy: userId,
      participants: participantIds,
    });

    return { success: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async ensureGroupParticipant(userId: string, conversationId: string) {
    const conv = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        type: 'group',
        'participants.userId': userId,
      })
      .lean();

    if (!conv) throw new ForbiddenException('Nhóm không tồn tại hoặc bạn không thuộc nhóm này');
    return conv;
  }

  private async insertSystemMessage(conversationId: Types.ObjectId, content: string) {
    const msg = await this.messageModel.create({
      conversationId,
      senderId: 'system',
      type: 'system',
      content,
      attachments: [],
    });

    await this.conversationModel.updateOne(
      { _id: conversationId },
      {
        lastMessage: {
          senderId: 'system',
          content,
          type: 'system',
          sentAt: msg.createdAt,
        },
      }
    );

    // Emit to update conversation list in real-time
    const conv = await this.conversationModel.findById(conversationId).lean();
    if (conv) {
      const participantIds = conv.participants.map((p) => p.userId);
      await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_CREATED, {
        messageId: msg._id.toString(),
        conversationId: conversationId.toString(),
        senderId: 'system',
        participants: participantIds,
        content,
        type: 'system',
        attachments: [],
        createdAt: msg.createdAt,
      });
    }
  }

  private async ensureParticipant(userId: string, conversationId: string) {
    const conv = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        'participants.userId': userId,
      })
      .lean();

    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');
    return conv;
  }

  // ── Media / File / Link ───────────────────────────────────────────────────

  async getConversationMedia(
    userId: string,
    conversationId: string,
    type: 'image' | 'file' | 'link',
    cursor?: string,
    limit = 20
  ) {
    const conv = await this.ensureParticipant(userId, conversationId);

    const baseFilter: FilterQuery<MessageDocument> = {
      conversationId: conv._id,
      deletedFor: { $ne: userId },
      revokedAt: null,
    };

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (isNaN(cursorDate.getTime())) {
        throw new BadRequestException('cursor không hợp lệ');
      }
      baseFilter.createdAt = { $lt: cursorDate };
    }

    if (type === 'image') {
      const filter = { ...baseFilter, 'attachments.type': { $in: ['image', 'video'] } };
      const messages = await this.messageModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .select('senderId attachments createdAt')
        .lean();

      const hasMore = messages.length > limit;
      if (hasMore) messages.pop();

      const items = messages.flatMap((m) =>
        m.attachments
          .filter((a) => a.type === 'image' || a.type === 'video')
          .map((a) => ({
            messageId: (m._id as Types.ObjectId).toString(),
            senderId: m.senderId,
            createdAt: m.createdAt,
            url: a.url,
            type: a.type,
            thumbnailUrl: a.thumbnailUrl ?? null,
            filename: a.filename,
            size: a.size,
          }))
      );

      return {
        items,
        hasMore,
        nextCursor: messages.length ? messages[messages.length - 1].createdAt : null,
      };
    }

    if (type === 'file') {
      const filter = { ...baseFilter, 'attachments.type': 'file' };
      const messages = await this.messageModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .select('senderId attachments createdAt')
        .lean();

      const hasMore = messages.length > limit;
      if (hasMore) messages.pop();

      const items = messages.flatMap((m) =>
        m.attachments
          .filter((a) => a.type === 'file')
          .map((a) => ({
            messageId: (m._id as Types.ObjectId).toString(),
            senderId: m.senderId,
            createdAt: m.createdAt,
            url: a.url,
            filename: a.filename,
            size: a.size,
            mimeType: a.mimeType,
          }))
      );

      return {
        items,
        hasMore,
        nextCursor: messages.length ? messages[messages.length - 1].createdAt : null,
      };
    }

    // type === 'link'
    const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
    const filter = {
      ...baseFilter,
      type: 'text',
      content: { $regex: 'https?://', $options: 'i' },
    };
    const messages = await this.messageModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .select('senderId content createdAt')
      .lean();

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    const items = messages.flatMap((m) => {
      const urls = m.content?.match(URL_REGEX) ?? [];
      return urls.map((url) => ({
        messageId: (m._id as Types.ObjectId).toString(),
        senderId: m.senderId,
        createdAt: m.createdAt,
        url,
        domain: (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return url;
          }
        })(),
      }));
    });

    return {
      items,
      hasMore,
      nextCursor: messages.length ? messages[messages.length - 1].createdAt : null,
    };
  }

  // ── New business features ────────────────────────────────────────────────

  async editMessage(userId: string, messageId: string, dto: EditMessageDto) {
    const message = await this.messageModel.findById(messageId);
    if (!message) throw new NotFoundException('Tin nhắn không tồn tại');
    if (message.senderId !== userId)
      throw new ForbiddenException('Chỉ người gửi mới có thể chỉnh sửa');
    if (message.revokedAt) throw new BadRequestException('Không thể sửa tin nhắn đã thu hồi');
    if (message.type === 'system') throw new BadRequestException('Không thể sửa tin nhắn hệ thống');

    const elapsed = Date.now() - message.createdAt.getTime();
    if (elapsed > EDIT_WINDOW_MS) {
      throw new BadRequestException('Chỉ có thể chỉnh sửa tin nhắn trong vòng 30 phút');
    }

    const oldContent = message.content;
    message.content = dto.content.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    const conv = await this.conversationModel.findById(message.conversationId).lean();
    const participantIds = conv?.participants.map((p) => p.userId) || [];

    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_EDITED, {
      messageId: message._id.toString(),
      conversationId: message.conversationId.toString(),
      participants: participantIds,
      senderId: userId,
      content: message.content,
      oldContent,
      editedAt: message.editedAt,
    });

    return message;
  }

  async pinMessage(userId: string, messageId: string, actorName = '') {
    const message = await this.messageModel.findById(messageId).lean();
    if (!message) throw new NotFoundException('Tin nhắn không tồn tại');
    if (message.revokedAt) throw new BadRequestException('Không thể ghim tin nhắn đã thu hồi');

    const conv = await this.conversationModel.findById(message.conversationId);
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại');

    const participant = conv.participants.find((p) => p.userId === userId);
    if (!participant) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');

    if (
      conv.type === 'group' &&
      (conv.settings as any)?.onlyAdminCanPin &&
      participant.role === 'member'
    ) {
      throw new ForbiddenException('Chỉ quản trị viên mới có thể ghim tin nhắn trong nhóm này');
    }

    // Check already pinned
    const alreadyPinned = conv.pinnedMessages?.some((p) => p.messageId === messageId);
    if (alreadyPinned) throw new BadRequestException('Tin nhắn đã được ghim');

    // Enforce max 50 pinned messages
    if ((conv.pinnedMessages?.length ?? 0) >= MAX_PINNED_MESSAGES) {
      throw new BadRequestException(`Chỉ có thể ghim tối đa ${MAX_PINNED_MESSAGES} tin nhắn`);
    }

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $push: { pinnedMessages: { messageId, pinnedBy: userId, pinnedAt: new Date() } } }
    );

    await this.insertSystemMessage(conv._id, `${actorName || '—'} đã ghim một tin nhắn`);

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_PINNED, {
      messageId,
      conversationId: conv._id.toString(),
      participants: participantIds,
      pinnedBy: userId,
    });

    return { success: true };
  }

  async unpinMessage(userId: string, messageId: string, actorName = '') {
    const message = await this.messageModel.findById(messageId).lean();
    if (!message) throw new NotFoundException('Tin nhắn không tồn tại');

    const conv = await this.conversationModel.findById(message.conversationId);
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại');

    const participant = conv.participants.find((p) => p.userId === userId);
    if (!participant) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');

    if (
      conv.type === 'group' &&
      (conv.settings as any)?.onlyAdminCanPin &&
      participant.role === 'member'
    ) {
      throw new ForbiddenException('Chỉ quản trị viên mới có thể bỏ ghim tin nhắn trong nhóm này');
    }

    const wasPinned = conv.pinnedMessages?.some((p) => p.messageId === messageId);
    if (!wasPinned) throw new BadRequestException('Tin nhắn không được ghim');

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $pull: { pinnedMessages: { messageId } } }
    );

    await this.insertSystemMessage(conv._id, `${actorName || '—'} đã bỏ ghim một tin nhắn`);

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_UNPINNED, {
      messageId,
      conversationId: conv._id.toString(),
      participants: participantIds,
      unpinnedBy: userId,
    });

    return { success: true };
  }

  async getPinnedMessages(
    userId: string,
    conversationId: string
  ): Promise<Array<Record<string, unknown>>> {
    const conv = await this.ensureParticipant(userId, conversationId);
    if (!conv.pinnedMessages?.length) return [];

    const messageIds = conv.pinnedMessages.map((p) => new Types.ObjectId(p.messageId));
    const messages = await this.messageModel.find({ _id: { $in: messageIds } }).lean();

    // Attach pinnedBy and pinnedAt metadata
    return messages.map((msg) => {
      const pin = conv.pinnedMessages.find((p) => p.messageId === msg._id.toString());
      return { ...msg, pinnedBy: pin?.pinnedBy, pinnedAt: pin?.pinnedAt };
    });
  }

  async updateSettings(userId: string, conversationId: string, dto: UpdateSettingsDto) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner']);

    const updates: Record<string, boolean> = {};
    if (dto.onlyAdminCanSend !== undefined)
      updates['settings.onlyAdminCanSend'] = dto.onlyAdminCanSend;
    if (dto.onlyAdminCanPin !== undefined)
      updates['settings.onlyAdminCanPin'] = dto.onlyAdminCanPin;
    if (dto.allowMemberInvite !== undefined)
      updates['settings.allowMemberInvite'] = dto.allowMemberInvite;
    if (dto.requireJoinApproval !== undefined)
      updates['settings.requireJoinApproval'] = dto.requireJoinApproval;
    if (dto.chatHistoryForNewMembers !== undefined)
      updates['settings.chatHistoryForNewMembers'] = dto.chatHistoryForNewMembers;

    if (Object.keys(updates).length === 0) throw new BadRequestException('Không có thay đổi nào');

    await this.conversationModel.updateOne({ _id: conv._id }, { $set: updates });

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.CONVERSATION_SETTINGS_UPDATED, {
      conversationId: conv._id.toString(),
      participants: participantIds,
      settings: dto,
    });

    return { success: true };
  }

  async banMember(
    userId: string,
    conversationId: string,
    memberId: string,
    dto: BanMemberDto,
    actorName = ''
  ) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner', 'admin']);

    if (memberId === userId) throw new BadRequestException('Không thể tự ban mình');

    const target = conv.participants.find((p) => p.userId === memberId);
    if (!target) throw new BadRequestException('Thành viên không có trong nhóm');

    const actor = conv.participants.find((p) => p.userId === userId);
    if (actor?.role === 'admin' && (target.role === 'owner' || target.role === 'admin')) {
      throw new ForbiddenException('Phó nhóm không thể ban Chủ nhóm hoặc Phó nhóm khác');
    }

    const bannedUntil = dto.bannedUntil ? new Date(dto.bannedUntil) : null;
    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': memberId },
      { $set: { 'participants.$.isBanned': true, 'participants.$.bannedUntil': bannedUntil } }
    );

    await this.insertSystemMessage(
      conv._id,
      `${actorName || '—'} đã cấm một thành viên gửi tin nhắn`
    );

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.MEMBER_BANNED, {
      conversationId: conv._id.toString(),
      participants: participantIds,
      bannedBy: userId,
      memberId,
      bannedUntil,
    });

    return { success: true };
  }

  async unbanMember(userId: string, conversationId: string, memberId: string, actorName = '') {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner', 'admin']);

    const target = conv.participants.find((p) => p.userId === memberId);
    if (!target) throw new BadRequestException('Thành viên không có trong nhóm');
    if (!target.isBanned) throw new BadRequestException('Thành viên không bị ban');

    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': memberId },
      { $set: { 'participants.$.isBanned': false, 'participants.$.bannedUntil': null } }
    );

    await this.insertSystemMessage(conv._id, `${actorName || '—'} đã bỏ cấm một thành viên`);

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.MEMBER_UNBANNED, {
      conversationId: conv._id.toString(),
      participants: participantIds,
      unbannedBy: userId,
      memberId,
    });

    return { success: true };
  }

  async updateMySettings(userId: string, conversationId: string, dto: UpdateMySettingsDto) {
    const conv = await this.ensureParticipant(userId, conversationId);

    const updates: Record<string, boolean | Date | null> = {};
    if (dto.isPinned !== undefined) updates['participants.$.isPinned'] = dto.isPinned;
    if (dto.isArchived !== undefined) updates['participants.$.isArchived'] = dto.isArchived;
    if (dto.isMuted !== undefined) updates['participants.$.isMuted'] = dto.isMuted;
    if (dto.muteUntil !== undefined)
      updates['participants.$.muteUntil'] = dto.muteUntil ? new Date(dto.muteUntil) : null;

    if (Object.keys(updates).length === 0) throw new BadRequestException('Không có thay đổi nào');

    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': userId },
      { $set: updates }
    );

    return { success: true };
  }

  async markAsRead(userId: string, conversationId: string) {
    const conv = await this.ensureParticipant(userId, conversationId);

    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': userId },
      { $set: { 'participants.$.lastReadAt': new Date() } }
    );

    return { success: true };
  }
}
