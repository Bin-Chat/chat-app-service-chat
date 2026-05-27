import { randomUUID } from 'crypto';
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
import { Task, TaskDocument } from './schemas/task.schema';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { AddTaskCommentDto } from './dto/add-task-comment.dto';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    @InjectModel(Task.name) private taskModel: Model<TaskDocument>,
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

  private async emitTaskEvent(eventKey: string, conv: any, payload: Record<string, unknown>) {
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
            messageId: (msg._id as Types.ObjectId).toString(),
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
          messageId: (msg._id as Types.ObjectId).toString(),
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

  // ── Reads ───────────────────────────────────────────────────────────

  async getTasks(userId: string, conversationId: string, status?: string) {
    await this.ensureParticipant(userId, conversationId);
    const filter: Record<string, unknown> = {
      conversationId: new Types.ObjectId(conversationId),
    };
    if (status && ['todo', 'in_progress', 'done'].includes(status)) {
      filter.status = status;
    }
    return this.taskModel
      .find(filter)
      .sort({ status: 1, dueDate: 1, createdAt: -1 })
      .lean();
  }

  async getTaskStats(userId: string, conversationId: string) {
    await this.ensureParticipant(userId, conversationId);
    const stats = await this.taskModel.aggregate([
      { $match: { conversationId: new Types.ObjectId(conversationId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const result = { total: 0, todo: 0, in_progress: 0, done: 0 };
    for (const s of stats) {
      const key = s._id as keyof typeof result;
      if (key in result) result[key] = s.count;
      result.total += s.count;
    }
    return result;
  }

  // ── Writes ──────────────────────────────────────────────────────────

  async createTask(userId: string, conversationId: string, dto: CreateTaskDto, actorName = '') {
    const conv = await this.ensureParticipant(userId, conversationId);

    const task = await this.taskModel.create({
      conversationId: new Types.ObjectId(conversationId),
      createdBy: userId,
      title: dto.title,
      description: dto.description ?? '',
      assigneeId: dto.assigneeId ?? null,
      priority: dto.priority ?? 'medium',
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
    });

    const obj = task.toObject();
    await this.emitTaskEvent(CHAT_EVENTS.TASK_CREATED, conv, {
      conversationId,
      task: obj,
    });

    if (dto.assigneeId && dto.assigneeId !== userId) {
      await this.emitTaskEvent(CHAT_EVENTS.TASK_ASSIGNED, conv, {
        conversationId,
        taskId: (task._id as Types.ObjectId).toString(),
        assigneeId: dto.assigneeId,
        title: dto.title,
        assignedBy: userId,
      });
    }

    const actor = actorName || 'Ai đó';
    await this.insertSystemMessage(
      new Types.ObjectId(conversationId),
      `${actor} đã tạo công việc "${dto.title}"`,
      {
        type: 'task_action',
        action: 'create',
        taskId: (task._id as Types.ObjectId).toString(),
        title: dto.title,
        assigneeId: dto.assigneeId ?? null,
        priority: dto.priority ?? 'medium',
        actorName: actor,
      }
    );

    return obj;
  }

  /** Bulk create — used by the AI agent. Emits ONE system message with the full list. */
  async createTasksBatch(
    createdBy: string,
    conversationId: string,
    dtos: CreateTaskDto[],
    actorName = 'BinChat Bot'
  ) {
    if (!dtos.length) throw new BadRequestException('Danh sách task rỗng');
    const conv = await this.ensureParticipant(createdBy, conversationId);
    const batchId = randomUUID();
    const convOid = new Types.ObjectId(conversationId);

    const docs = await this.taskModel.insertMany(
      dtos.map((d) => ({
        conversationId: convOid,
        createdBy,
        batchId,
        title: d.title,
        description: d.description ?? '',
        assigneeId: d.assigneeId ?? null,
        priority: d.priority ?? 'medium',
        dueDate: d.dueDate ? new Date(d.dueDate) : null,
      }))
    );

    const objs = docs.map((d) => d.toObject());

    // Fire one TASK_CREATED batch event
    await this.emitTaskEvent(CHAT_EVENTS.TASK_CREATED, conv, {
      conversationId,
      batchId,
      tasks: objs,
    });

    // Per-assignee notification
    for (const t of objs) {
      if (t.assigneeId && t.assigneeId !== createdBy) {
        await this.emitTaskEvent(CHAT_EVENTS.TASK_ASSIGNED, conv, {
          conversationId,
          taskId: (t._id as Types.ObjectId).toString(),
          assigneeId: t.assigneeId,
          title: t.title,
          assignedBy: createdBy,
        });
      }
    }

    // Single system message representing the whole batch
    await this.insertSystemMessage(
      convOid,
      `${actorName} đã tạo ${objs.length} công việc cho nhóm`,
      {
        type: 'task_list_created',
        batchId,
        actorName,
        createdBy,
        tasks: objs.map((t) => ({
          taskId: (t._id as Types.ObjectId).toString(),
          title: t.title,
          assigneeId: t.assigneeId,
          priority: t.priority,
          dueDate: t.dueDate,
        })),
      }
    );

    return objs;
  }

  async updateTask(userId: string, taskId: string, dto: UpdateTaskDto) {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new NotFoundException('Công việc không tồn tại');

    const conv = await this.conversationModel
      .findOne({ _id: task.conversationId, 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');

    const participant = conv.participants.find((p: any) => p.userId === userId);
    const isOwnerOrAdmin = participant?.role === 'owner' || participant?.role === 'admin';
    const isCreator = task.createdBy === userId;
    const isAssignee = task.assigneeId === userId;

    if (!isCreator && !isAssignee && !isOwnerOrAdmin) {
      throw new ForbiddenException('Bạn không có quyền sửa công việc này');
    }

    const prevAssignee = task.assigneeId;
    if (dto.title !== undefined) task.title = dto.title;
    if (dto.description !== undefined) task.description = dto.description;
    if (dto.assigneeId !== undefined) task.assigneeId = dto.assigneeId;
    if (dto.priority !== undefined) task.priority = dto.priority;
    if (dto.dueDate !== undefined) {
      task.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    }
    if (dto.status !== undefined) {
      task.status = dto.status;
      if (dto.status === 'done' && !task.completedAt) {
        task.completedAt = new Date();
        task.completedBy = userId;
      } else if (dto.status !== 'done') {
        task.completedAt = null;
        task.completedBy = null;
      }
    }

    await task.save();
    const obj = task.toObject();

    await this.emitTaskEvent(CHAT_EVENTS.TASK_UPDATED, conv, {
      conversationId: task.conversationId.toString(),
      task: obj,
    });

    if (dto.assigneeId && dto.assigneeId !== prevAssignee && dto.assigneeId !== userId) {
      await this.emitTaskEvent(CHAT_EVENTS.TASK_ASSIGNED, conv, {
        conversationId: task.conversationId.toString(),
        taskId,
        assigneeId: dto.assigneeId,
        title: task.title,
        assignedBy: userId,
      });
    }

    return obj;
  }

  async completeTask(userId: string, taskId: string, actorName = '') {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new NotFoundException('Công việc không tồn tại');

    const conv = await this.conversationModel
      .findOne({ _id: task.conversationId, 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');

    if (task.status === 'done') return task.toObject();

    task.status = 'done';
    task.completedAt = new Date();
    task.completedBy = userId;
    await task.save();
    const obj = task.toObject();

    await this.emitTaskEvent(CHAT_EVENTS.TASK_COMPLETED, conv, {
      conversationId: task.conversationId.toString(),
      taskId,
      task: obj,
      completedBy: userId,
    });

    const actor = actorName || 'Ai đó';
    await this.insertSystemMessage(
      task.conversationId as Types.ObjectId,
      `${actor} đã hoàn thành công việc "${task.title}"`,
      {
        type: 'task_action',
        action: 'complete',
        taskId,
        title: task.title,
        actorName: actor,
      }
    );

    return obj;
  }

  async deleteTask(userId: string, taskId: string) {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new NotFoundException('Công việc không tồn tại');

    const conv = await this.conversationModel
      .findOne({ _id: task.conversationId, 'participants.userId': userId })
      .lean();
    if (!conv) throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này');

    const participant = conv.participants.find((p: any) => p.userId === userId);
    const isOwnerOrAdmin = participant?.role === 'owner' || participant?.role === 'admin';
    if (task.createdBy !== userId && !isOwnerOrAdmin) {
      throw new ForbiddenException('Chỉ người tạo hoặc admin mới được xóa');
    }

    await this.taskModel.deleteOne({ _id: task._id });
    await this.emitTaskEvent(CHAT_EVENTS.TASK_DELETED, conv, {
      conversationId: task.conversationId.toString(),
      taskId,
    });

    return { success: true };
  }

  async addComment(userId: string, taskId: string, dto: AddTaskCommentDto) {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new NotFoundException('Công việc không tồn tại');

    await this.ensureParticipant(userId, task.conversationId.toString());

    const comment = {
      _id: new Types.ObjectId(),
      userId,
      content: dto.content,
      createdAt: new Date(),
    } as any;
    task.comments.push(comment);
    await task.save();
    const obj = task.toObject();

    const conv = await this.conversationModel
      .findById(task.conversationId)
      .select('participants')
      .lean();
    await this.emitTaskEvent(CHAT_EVENTS.TASK_UPDATED, conv, {
      conversationId: task.conversationId.toString(),
      task: obj,
    });

    return obj;
  }
}
