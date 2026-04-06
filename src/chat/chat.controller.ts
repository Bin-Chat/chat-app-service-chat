import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { ChatService } from './chat.service';
import { AddMembersDto } from './dto/add-members.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { RemoveMemberDto } from './dto/remove-member.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { TransferOwnerDto } from './dto/transfer-owner.dto';
import { UpdateGroupDto } from './dto/update-group.dto';

@Controller('chat')
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'chat-service', timestamp: new Date().toISOString() };
  }
}

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private chatService: ChatService) {}

  // ── Conversations ───────────────────────────────────────────────────────

  @Post('conversations')
  createConversation(@Request() req, @Body() dto: CreateConversationDto) {
    return this.chatService.createConversation(req.user.sub, dto);
  }

  @Get('conversations')
  getConversations(@Request() req) {
    return this.chatService.getConversations(req.user.sub);
  }

  @Get('conversations/:id')
  getConversation(@Request() req, @Param('id') id: string) {
    return this.chatService.getConversation(req.user.sub, id);
  }

  // ── Messages ──────────────────────────────────────────────────────────

  @Get('conversations/:id/messages')
  getMessages(
    @Request() req,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    return this.chatService.getMessages(req.user.sub, id, cursor, limit ? parseInt(limit, 10) : 30);
  }

  @Post('conversations/:id/messages')
  sendMessage(@Request() req, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.chatService.sendMessage(req.user.sub, id, dto);
  }

  @Patch('messages/:id/revoke')
  @HttpCode(HttpStatus.OK)
  revokeMessage(@Request() req, @Param('id') id: string) {
    return this.chatService.revokeMessage(req.user.sub, id);
  }

  @Delete('messages/:id')
  @HttpCode(HttpStatus.OK)
  deleteMessage(@Request() req, @Param('id') id: string) {
    return this.chatService.deleteMessage(req.user.sub, id);
  }

  @Post('messages/:id/forward')
  forwardMessage(@Request() req, @Param('id') id: string, @Body() dto: ForwardMessageDto) {
    return this.chatService.forwardMessage(req.user.sub, id, dto);
  }

  @Post('messages/:id/react')
  reactToMessage(@Request() req, @Param('id') id: string, @Body() dto: ReactMessageDto) {
    return this.chatService.toggleReaction(req.user.sub, id, dto);
  }

  // ── Group Management ──────────────────────────────────────────────────

  @Get('conversations/:id/members')
  getGroupMembers(@Request() req, @Param('id') id: string) {
    return this.chatService.getGroupMembers(req.user.sub, id);
  }

  @Post('conversations/:id/members')
  addMembers(@Request() req, @Param('id') id: string, @Body() dto: AddMembersDto) {
    return this.chatService.addMembers(req.user.sub, id, dto);
  }

  @Delete('conversations/:id/members')
  @HttpCode(HttpStatus.OK)
  removeMember(@Request() req, @Param('id') id: string, @Body() dto: RemoveMemberDto) {
    return this.chatService.removeMember(req.user.sub, id, dto);
  }

  @Post('conversations/:id/leave')
  @HttpCode(HttpStatus.OK)
  leaveGroup(@Request() req, @Param('id') id: string) {
    return this.chatService.leaveGroup(req.user.sub, id);
  }

  @Patch('conversations/:id')
  updateGroup(@Request() req, @Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.chatService.updateGroup(req.user.sub, id, dto);
  }

  @Patch('conversations/:id/role')
  changeRole(@Request() req, @Param('id') id: string, @Body() dto: ChangeRoleDto) {
    return this.chatService.changeRole(req.user.sub, id, dto);
  }

  @Patch('conversations/:id/transfer')
  transferOwnership(@Request() req, @Param('id') id: string, @Body() dto: TransferOwnerDto) {
    return this.chatService.transferOwnership(req.user.sub, id, dto);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.OK)
  dissolveGroup(@Request() req, @Param('id') id: string) {
    return this.chatService.dissolveGroup(req.user.sub, id);
  }
}
