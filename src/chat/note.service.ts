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
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import { Note, NoteDocument } from './schemas/note.schema';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';

const MAX_PINNED_NOTES = 3;

@Injectable()
export class NoteService {
  private readonly logger = new Logger(NoteService.name);

  constructor(
    @InjectModel(Note.name) private noteModel: Model<NoteDocument>,
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    private kafkaProducer: KafkaProducerService
  ) {}

  private async ensureParticipant(userId: string, conversationId: string) {
    const conv = await this.conversationModel
      .findOne({ _id: new Types.ObjectId(conversationId), 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');
    return conv;
  }

  private async emitNoteEvent(eventKey: string, conv: any, payload: Record<string, unknown>) {
    try {
      const participantIds = (conv?.participants ?? []).map((p: any) => p.userId);
      await this.kafkaProducer.emit(eventKey, { ...payload, participantIds });
    } catch (err) {
      this.logger.warn(`Failed to emit ${eventKey}: ${(err as Error).message}`);
    }
  }

  private async insertSystemMessage(
    conversationId: Types.ObjectId,
    content: string,
    metadata?: Record<string, any>
  ) {
    try {
      const msg = await this.messageModel.create({
        conversationId,
        senderId: 'system',
        type: 'system',
        content,
        metadata: metadata ?? null,
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

      const conv = await this.conversationModel.findById(conversationId).lean();
      if (conv) {
        const participantIds = conv.participants.map((p: any) => p.userId);
        await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_CREATED, {
          messageId: (msg._id as any).toString(),
          conversationId: conversationId.toString(),
          senderId: 'system',
          participants: participantIds,
          content,
          type: 'system',
          metadata: metadata ?? null,
          attachments: [],
          createdAt: msg.createdAt,
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to insert system message: ${(err as Error).message}`);
    }
  }

  async createNote(userId: string, conversationId: string, dto: CreateNoteDto, actorName = '') {
    const conv = await this.ensureParticipant(userId, conversationId);

    if (dto.isPinned) {
      const pinnedCount = await this.noteModel.countDocuments({
        conversationId: new Types.ObjectId(conversationId),
        isPinned: true,
      });
      if (pinnedCount >= MAX_PINNED_NOTES) {
        throw new BadRequestException(
          `Chỉ được ghim tối đa ${MAX_PINNED_NOTES} ghi chú. Hãy bỏ ghim một ghi chú trước.`
        );
      }
    }

    const note = await this.noteModel.create({
      conversationId: new Types.ObjectId(conversationId),
      createdBy: userId,
      content: dto.content,
      isPinned: dto.isPinned ?? false,
    });

    const obj = note.toObject();
    await this.emitNoteEvent(CHAT_EVENTS.NOTE_CREATED, conv, {
      noteId: (note._id as any).toString(),
      conversationId,
      note: obj,
    });

    const actor = actorName || 'Ai đó';
    const action = dto.isPinned ? 'create_pin' : 'create';
    const systemText = dto.isPinned
      ? `${actor} đã tạo và ghim một ghi chú`
      : `${actor} đã tạo một ghi chú`;
    await this.insertSystemMessage(new Types.ObjectId(conversationId), systemText, {
      type: 'note_action',
      action,
      noteId: (note._id as any).toString(),
      content: note.content,
      actorName: actor,
      isPinned: note.isPinned,
    });

    return obj;
  }

  async getNotes(userId: string, conversationId: string) {
    await this.ensureParticipant(userId, conversationId);

    return this.noteModel
      .find({ conversationId: new Types.ObjectId(conversationId) })
      .sort({ isPinned: -1, updatedAt: -1 })
      .lean();
  }

  async updateNote(userId: string, noteId: string, dto: UpdateNoteDto, actorName = '') {
    const note = await this.noteModel.findById(noteId);
    if (!note) throw new NotFoundException('Ghi chú không tồn tại');
    if (note.createdBy !== userId)
      throw new ForbiddenException('Chỉ người tạo mới được sửa ghi chú');

    const wasPinned = note.isPinned;
    const willPin = dto.isPinned === true && !wasPinned;

    if (willPin) {
      const pinnedCount = await this.noteModel.countDocuments({
        conversationId: note.conversationId,
        isPinned: true,
      });
      if (pinnedCount >= MAX_PINNED_NOTES) {
        throw new BadRequestException(
          `Chỉ được ghim tối đa ${MAX_PINNED_NOTES} ghi chú. Hãy bỏ ghim một ghi chú trước.`
        );
      }
    }

    if (dto.content !== undefined) note.content = dto.content;
    if (dto.isPinned !== undefined) note.isPinned = dto.isPinned;
    await note.save();

    const conv = await this.conversationModel
      .findById(note.conversationId)
      .select('participants')
      .lean();
    const obj = note.toObject();
    await this.emitNoteEvent(CHAT_EVENTS.NOTE_UPDATED, conv, {
      noteId,
      conversationId: note.conversationId.toString(),
      note: obj,
    });

    const actor = actorName || 'Ai đó';
    let systemText: string;
    let updateAction: string;
    if (willPin) {
      systemText = `${actor} đã ghim một ghi chú`;
      updateAction = 'pin';
    } else if (dto.isPinned === false && wasPinned) {
      systemText = `${actor} đã bỏ ghim một ghi chú`;
      updateAction = 'unpin';
    } else {
      systemText = `${actor} đã chỉnh sửa một ghi chú`;
      updateAction = 'edit';
    }
    await this.insertSystemMessage(note.conversationId as Types.ObjectId, systemText, {
      type: 'note_action',
      action: updateAction,
      noteId,
      content: note.content,
      actorName: actor,
      isPinned: note.isPinned,
    });

    return obj;
  }

  async deleteNote(userId: string, noteId: string, actorName = '') {
    const note = await this.noteModel.findById(noteId);
    if (!note) throw new NotFoundException('Ghi chú không tồn tại');

    const conv = await this.conversationModel
      .findOne({ _id: note.conversationId, 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');

    const participant = conv.participants.find((p: any) => p.userId === userId);
    const isOwnerOrAdmin = participant?.role === 'owner' || participant?.role === 'admin';

    if (note.createdBy !== userId && !isOwnerOrAdmin) {
      throw new ForbiddenException('Bạn không có quyền xóa ghi chú này');
    }

    await this.noteModel.deleteOne({ _id: noteId });

    await this.emitNoteEvent(CHAT_EVENTS.NOTE_DELETED, conv, {
      noteId,
      conversationId: note.conversationId.toString(),
    });

    const actor = actorName || 'Ai đó';
    await this.insertSystemMessage(
      note.conversationId as Types.ObjectId,
      `${actor} đã xóa một ghi chú`,
      { type: 'note_action', action: 'delete', noteId, actorName: actor }
    );

    return { success: true };
  }
}
