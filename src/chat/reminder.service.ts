import { Injectable, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron } from '@nestjs/schedule';

import { CHAT_EVENTS } from '../kafka/events/chat.events';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import { Reminder, ReminderDocument } from './schemas/reminder.schema';
import { CreateReminderDto } from './dto/create-reminder.dto';
import { UpdateReminderDto } from './dto/update-reminder.dto';

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    @InjectModel(Reminder.name) private reminderModel: Model<ReminderDocument>,
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    private kafkaProducer: KafkaProducerService
  ) {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async ensureParticipant(userId: string, conversationId: string) {
    const conv = await this.conversationModel
      .findOne({ _id: new Types.ObjectId(conversationId), 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');
    return conv;
  }

  private calculateNextRemindAt(current: Date, repeat: string): Date {
    const next = new Date(current);
    switch (repeat) {
      case 'daily':
        next.setDate(next.getDate() + 1);
        break;
      case 'weekly':
        next.setDate(next.getDate() + 7);
        break;
      case 'monthly':
        next.setMonth(next.getMonth() + 1);
        break;
    }
    return next;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async createReminder(userId: string, conversationId: string, dto: CreateReminderDto) {
    const conv = await this.ensureParticipant(userId, conversationId);

    const reminder = await this.reminderModel.create({
      conversationId: new Types.ObjectId(conversationId),
      createdBy: userId,
      content: dto.content,
      remindAt: new Date(dto.remindAt),
      repeat: dto.repeat ?? 'none',
    });

    // Create system message in chat so the reminder card appears in the timeline
    const reminderId = (reminder._id as any).toString();
    const systemContent = `reminder_created`;
    const metadata = {
      type: 'reminder_created',
      reminderId,
      content: reminder.content,
      remindAt: reminder.remindAt.toISOString(),
      repeat: reminder.repeat,
      createdBy: userId,
    };

    const msg = await this.messageModel.create({
      conversationId: new Types.ObjectId(conversationId),
      senderId: 'system',
      type: 'system',
      content: systemContent,
      metadata,
      attachments: [],
    });

    const participantIds = (conv as any).participants.map((p: any) => p.userId);

    await this.conversationModel.updateOne(
      { _id: new Types.ObjectId(conversationId) },
      {
        lastMessage: {
          senderId: 'system',
          content: `Nhắc hẹn mới: ${reminder.content}`,
          type: 'system',
          sentAt: msg.createdAt,
        },
      }
    );

    await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_CREATED, {
      messageId: (msg._id as any).toString(),
      conversationId,
      senderId: 'system',
      participants: participantIds,
      content: systemContent,
      type: 'system',
      metadata,
      attachments: [],
      createdAt: msg.createdAt,
    });

    return reminder.toObject();
  }

  async getReminders(userId: string, conversationId: string) {
    await this.ensureParticipant(userId, conversationId);

    const reminders = await this.reminderModel
      .find({ conversationId: new Types.ObjectId(conversationId) })
      .sort({ remindAt: 1 })
      .lean();

    return reminders;
  }

  async updateReminder(userId: string, reminderId: string, dto: UpdateReminderDto) {
    const reminder = await this.reminderModel.findById(reminderId);
    if (!reminder) throw new NotFoundException('Nhắc hẹn không tồn tại');
    if (reminder.createdBy !== userId)
      throw new ForbiddenException('Chỉ người tạo mới được sửa nhắc hẹn');

    if (dto.content !== undefined) reminder.content = dto.content;
    if (dto.remindAt !== undefined) reminder.remindAt = new Date(dto.remindAt);
    if (dto.repeat !== undefined) reminder.repeat = dto.repeat;
    // Re-activate if editing a completed reminder
    reminder.isCompleted = false;
    reminder.lastFiredAt = null;

    await reminder.save();

    const conv = await this.conversationModel
      .findById(reminder.conversationId)
      .select('participants')
      .lean();
    const participantIds = (conv as any)?.participants?.map((p: any) => p.userId) ?? [];
    await this.kafkaProducer.emit(CHAT_EVENTS.REMINDER_UPDATED, {
      reminderId,
      conversationId: reminder.conversationId.toString(),
      reminder: reminder.toObject(),
      participantIds,
    });

    return reminder.toObject();
  }

  async deleteReminder(userId: string, reminderId: string) {
    const reminder = await this.reminderModel.findById(reminderId);
    if (!reminder) throw new NotFoundException('Nhắc hẹn không tồn tại');

    // Verify user is a member of the conversation
    const conv = await this.conversationModel
      .findOne({ _id: reminder.conversationId, 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');

    const participant = conv.participants.find((p: any) => p.userId === userId);
    const isOwnerOrAdmin = participant?.role === 'owner' || participant?.role === 'admin';

    if (reminder.createdBy !== userId && !isOwnerOrAdmin) {
      throw new ForbiddenException('Bạn không có quyền xóa nhắc hẹn này');
    }

    await this.reminderModel.deleteOne({ _id: reminderId });

    const participantIds = (conv as any).participants.map((p: any) => p.userId);
    await this.kafkaProducer.emit(CHAT_EVENTS.REMINDER_DELETED, {
      reminderId,
      conversationId: reminder.conversationId.toString(),
      participantIds,
    });

    return { success: true };
  }

  async completeReminder(userId: string, reminderId: string) {
    const reminder = await this.reminderModel.findById(reminderId);
    if (!reminder) throw new NotFoundException('Nhắc hẹn không tồn tại');

    await this.ensureParticipant(userId, reminder.conversationId.toString());

    reminder.isCompleted = true;
    await reminder.save();
    return reminder.toObject();
  }

  async rsvpReminder(userId: string, reminderId: string, name: string, status: 'yes' | 'no') {
    const reminder = await this.reminderModel.findById(reminderId);
    if (!reminder) throw new NotFoundException('Nhắc hẹn không tồn tại');

    await this.ensureParticipant(userId, reminder.conversationId.toString());

    // Upsert RSVP
    const idx = reminder.rsvps.findIndex((r: any) => r.userId === userId);
    if (idx >= 0) {
      reminder.rsvps[idx].status = status;
      reminder.rsvps[idx].name = name;
    } else {
      reminder.rsvps.push({ userId, name, status } as any);
    }

    await reminder.save();

    const conv = await this.conversationModel
      .findById(reminder.conversationId)
      .select('participants')
      .lean();
    const participantIds = (conv as any)?.participants?.map((p: any) => p.userId) ?? [];
    await this.kafkaProducer.emit(CHAT_EVENTS.REMINDER_UPDATED, {
      reminderId,
      conversationId: reminder.conversationId.toString(),
      reminder: reminder.toObject(),
      participantIds,
    });

    return reminder.toObject();
  }

  // ── Cron job: every minute ─────────────────────────────────────────────────

  @Cron('* * * * *')
  async handleReminderCron() {
    const now = new Date();

    // Find all due reminders not yet completed
    // lastFiredAt null = never fired; $expr compares two fields (repeating reminders)
    const dueReminders = await this.reminderModel
      .find({
        remindAt: { $lte: now },
        isCompleted: false,
        $or: [{ lastFiredAt: null }, { $expr: { $lt: ['$lastFiredAt', '$remindAt'] } }],
      })
      .lean();

    if (dueReminders.length === 0) return;

    this.logger.log(`Firing ${dueReminders.length} reminder(s)`);

    for (const reminder of dueReminders) {
      // Load conversation participants
      const conv = await this.conversationModel
        .findById(reminder.conversationId)
        .select('participants')
        .lean();

      if (!conv) {
        // Conversation deleted — mark complete
        await this.reminderModel.findByIdAndUpdate(reminder._id, { isCompleted: true });
        continue;
      }

      const participantIds = conv.participants.map((p: any) => p.userId);

      // Emit Kafka event → API Gateway will socket.io each participant
      await this.kafkaProducer.emit(CHAT_EVENTS.REMINDER_FIRED, {
        reminderId: (reminder._id as any).toString(),
        conversationId: reminder.conversationId.toString(),
        createdBy: reminder.createdBy,
        content: reminder.content,
        remindAt: reminder.remindAt.toISOString(),
        repeat: reminder.repeat,
        participantIds,
      });

      // Update reminder state
      if (reminder.repeat === 'none') {
        await this.reminderModel.findByIdAndUpdate(reminder._id, {
          isCompleted: true,
          lastFiredAt: now,
        });
      } else {
        const nextRemindAt = this.calculateNextRemindAt(reminder.remindAt, reminder.repeat);
        await this.reminderModel.findByIdAndUpdate(reminder._id, {
          remindAt: nextRemindAt,
          lastFiredAt: reminder.remindAt,
        });
      }
    }
  }
}
