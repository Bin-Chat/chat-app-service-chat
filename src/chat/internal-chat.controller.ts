import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { InternalGuard } from '../auth/internal.guard';
import { ChatService } from './chat.service';
import { TaskService } from './task.service';
import { InternalCreateTaskListDto } from './dto/create-task.dto';

/**
 * Endpoints called by other internal services (e.g., AI agent).
 * All routes require the `x-service-secret` header.
 */
@Controller('chat/internal')
@UseGuards(InternalGuard)
export class InternalChatController {
  constructor(
    private chatService: ChatService,
    private taskService: TaskService
  ) {}

  // ── Conversations ───────────────────────────────────────────────────

  @Get('conversations')
  getConversations(@Query('userId') userId: string) {
    return this.chatService.getConversations(userId);
  }

  @Get('conversations/:id/members')
  getConversationMembers(@Param('id') conversationId: string) {
    return this.chatService.getConversationMembersInternal(conversationId);
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @Param('id') conversationId: string,
    @Query('userId') userId: string,
    @Query('limit') limit?: string
  ) {
    const res = await this.chatService.getMessages(
      userId,
      conversationId,
      undefined,
      limit ? Number(limit) : 30
    );
    return res.messages;
  }

  // ── Tasks ───────────────────────────────────────────────────────────

  @Post('tasks')
  createTasks(@Body() dto: InternalCreateTaskListDto) {
    return this.taskService.createTasksBatch(
      dto.createdBy,
      dto.conversationId,
      dto.tasks,
      dto.actorName ?? 'BinChat Bot'
    );
  }

  @Get('tasks')
  listTasks(
    @Query('userId') userId: string,
    @Query('conversationId') conversationId: string,
    @Query('status') status?: string
  ) {
    return this.taskService.getTasks(userId, conversationId, status);
  }

  @Post('tasks/:taskId/complete')
  completeTask(
    @Param('taskId') taskId: string,
    @Query('userId') userId: string,
    @Query('actorName') actorName?: string
  ) {
    return this.taskService.completeTask(userId, taskId, actorName ?? 'BinChat Bot');
  }
}
