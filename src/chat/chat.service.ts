import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { CHAT_EVENTS } from '../kafka/events/chat.events';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

import { AddMembersDto } from './dto/add-members.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { RemoveMemberDto } from './dto/remove-member.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { TransferOwnerDto } from './dto/transfer-owner.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { checkGroupRole } from './guards/group-role.guard';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';

const REVOKE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

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

    const filter: any = {
      conversationId: conv._id,
      deletedFor: { $ne: userId },
    };

    if (cursor) {
      filter.createdAt = { $lt: new Date(cursor) };
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

    if (!dto.content?.trim() && (!dto.attachments || dto.attachments.length === 0)) {
      throw new BadRequestException('Tin nhắn phải có nội dung hoặc file đính kèm');
    }

    const message = await this.messageModel.create({
      conversationId: conv._id,
      senderId: userId,
      content: dto.content?.trim() || '',
      attachments: dto.attachments || [],
      replyTo: dto.replyTo ?? null,
    });

    // Update lastMessage on conversation
    const participantIds = conv.participants.map((p) => p.userId);
    const lastMessage = {
      senderId: userId,
      content: dto.content?.trim() || (dto.attachments?.length ? '[File]' : ''),
      type: dto.attachments?.length ? dto.attachments[0].type : 'text',
      sentAt: message.createdAt,
    };

    await this.conversationModel.updateOne({ _id: conv._id }, { lastMessage });

    // Emit Kafka events
    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_CREATED, {
      messageId: message._id.toString(),
      conversationId: conv._id.toString(),
      senderId: userId,
      participants: participantIds,
      content: message.content,
      type: lastMessage.type,
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
      throw new BadRequestException('Chỉ có thể thu hồi tin nhắn trong vòng 15 phút');
    }

    message.revokedAt = new Date();
    await message.save();

    const conv = await this.conversationModel.findById(message.conversationId);
    const participantIds = conv?.participants.map((p) => p.userId) || [];

    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_REVOKED, {
      messageId: message._id.toString(),
      conversationId: message.conversationId.toString(),
      senderId: userId,
      participants: participantIds,
      revokedAt: message.revokedAt,
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
      message.reactions.splice(existingIndex, 1);
      action = 'removed';
    } else {
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

  async addMembers(userId: string, conversationId: string, dto: AddMembersDto) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner', 'admin']);

    const existingIds = new Set(conv.participants.map((p) => p.userId));
    const newIds = dto.memberIds.filter((id) => !existingIds.has(id));
    if (newIds.length === 0) {
      throw new BadRequestException('Tất cả thành viên đã có trong nhóm');
    }

    const now = new Date();
    const newParticipants = newIds.map((id) => ({ userId: id, role: 'member', joinedAt: now }));

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $push: { participants: { $each: newParticipants } } },
    );

    // System message
    await this.insertSystemMessage(conv._id, `đã thêm ${newIds.length} thành viên vào nhóm`);

    const allParticipantIds = [...Array.from(existingIds), ...newIds];
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_MEMBERS_ADDED, {
      conversationId: conv._id.toString(),
      addedBy: userId,
      newMemberIds: newIds,
      participants: allParticipantIds,
    });

    return { success: true, addedCount: newIds.length };
  }

  async removeMember(userId: string, conversationId: string, dto: RemoveMemberDto) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    const actor = checkGroupRole(conv.participants, userId, ['owner', 'admin']);

    if (dto.memberId === userId) {
      throw new BadRequestException('Dùng chức năng rời nhóm thay vì tự xoá mình');
    }

    const target = conv.participants.find((p) => p.userId === dto.memberId);
    if (!target) {
      throw new BadRequestException('Thành viên không có trong nhóm');
    }

    // Admin cannot remove owner or other admins
    if (actor.role === 'admin' && (target.role === 'owner' || target.role === 'admin')) {
      throw new ForbiddenException('Phó nhóm không thể xoá Chủ nhóm hoặc Phó nhóm khác');
    }

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $pull: { participants: { userId: dto.memberId } } },
    );

    await this.insertSystemMessage(conv._id, `đã xoá một thành viên khỏi nhóm`);

    const remainingIds = conv.participants.filter((p) => p.userId !== dto.memberId).map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_MEMBER_REMOVED, {
      conversationId: conv._id.toString(),
      removedBy: userId,
      removedMemberId: dto.memberId,
      participants: [...remainingIds, dto.memberId], // notify removed member too
    });

    return { success: true };
  }

  async leaveGroup(userId: string, conversationId: string) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    const actor = conv.participants.find((p) => p.userId === userId);

    if (actor?.role === 'owner') {
      throw new BadRequestException(
        'Chủ nhóm phải chuyển quyền trước khi rời nhóm. Dùng API chuyển quyền chủ nhóm.',
      );
    }

    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $pull: { participants: { userId } } },
    );

    await this.insertSystemMessage(conv._id, `đã rời khỏi nhóm`);

    const remainingIds = conv.participants.filter((p) => p.userId !== userId).map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_MEMBER_LEFT, {
      conversationId: conv._id.toString(),
      userId,
      participants: [...remainingIds, userId],
    });

    return { success: true };
  }

  async updateGroup(userId: string, conversationId: string, dto: UpdateGroupDto) {
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

    await this.insertSystemMessage(conv._id, `đã cập nhật thông tin nhóm`);

    const participantIds = conv.participants.map((p) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.GROUP_UPDATED, {
      conversationId: conv._id.toString(),
      updatedBy: userId,
      changes: updates,
      participants: participantIds,
    });

    return { success: true, ...updates };
  }

  async changeRole(userId: string, conversationId: string, dto: ChangeRoleDto) {
    const conv = await this.ensureGroupParticipant(userId, conversationId);
    checkGroupRole(conv.participants, userId, ['owner']);

    const target = conv.participants.find((p) => p.userId === dto.memberId);
    if (!target) {
      throw new BadRequestException('Thành viên không có trong nhóm');
    }
    if (target.role === 'owner') {
      throw new BadRequestException('Không thể thay đổi quyền Chủ nhóm bằng API này');
    }

    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': dto.memberId },
      { $set: { 'participants.$.role': dto.role } },
    );

    const roleName = dto.role === 'admin' ? 'Phó nhóm' : 'Thành viên';
    await this.insertSystemMessage(conv._id, `đã đặt một thành viên làm ${roleName}`);

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

  async transferOwnership(userId: string, conversationId: string, dto: TransferOwnerDto) {
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
      { $set: { 'participants.$.role': 'admin' } },
    );
    await this.conversationModel.updateOne(
      { _id: conv._id, 'participants.userId': dto.newOwnerId },
      { $set: { 'participants.$.role': 'owner' } },
    );

    await this.insertSystemMessage(conv._id, `đã chuyển quyền Chủ nhóm`);

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
      },
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
}
