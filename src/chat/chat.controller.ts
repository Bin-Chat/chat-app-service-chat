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
import { CreateReminderDto } from './dto/create-reminder.dto';
import { UpdateReminderDto } from './dto/update-reminder.dto';
import { RsvpReminderDto } from './dto/rsvp-reminder.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { ReminderService } from './reminder.service';
import { NoteService } from './note.service';

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
  constructor(
    private chatService: ChatService,
    private reminderService: ReminderService,
    private noteService: NoteService
  ) {}

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

  @Patch('messages/:id')
  editMessage(@Request() req, @Param('id') id: string, @Body() dto: EditMessageDto) {
    return this.chatService.editMessage(req.user.sub, id, dto);
  }

  @Post('messages/:id/pin')
  @HttpCode(HttpStatus.OK)
  pinMessage(@Request() req, @Param('id') id: string) {
    return this.chatService.pinMessage(req.user.sub, id, req.user.name);
  }

  @Delete('messages/:id/pin')
  @HttpCode(HttpStatus.OK)
  unpinMessage(@Request() req, @Param('id') id: string) {
    return this.chatService.unpinMessage(req.user.sub, id, req.user.name);
  }

  @Get('conversations/:id/pinned')
  getPinnedMessages(
    @Request() req,
    @Param('id') id: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.chatService.getPinnedMessages(req.user.sub, id);
  }

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  markAsRead(@Request() req, @Param('id') id: string) {
    return this.chatService.markAsRead(req.user.sub, id);
  }

  // ── Group Management ──────────────────────────────────────────────────

  @Get('conversations/:id/members')
  getGroupMembers(@Request() req, @Param('id') id: string) {
    return this.chatService.getGroupMembers(req.user.sub, id);
  }

  @Post('conversations/:id/members')
  addMembers(@Request() req, @Param('id') id: string, @Body() dto: AddMembersDto) {
    return this.chatService.addMembers(req.user.sub, id, dto, req.user.name);
  }

  @Delete('conversations/:id/members/:memberId')
  @HttpCode(HttpStatus.OK)
  removeMember(@Request() req, @Param('id') id: string, @Param('memberId') memberId: string) {
    return this.chatService.removeMember(req.user.sub, id, memberId, req.user.name);
  }

  @Post('conversations/:id/leave')
  @HttpCode(HttpStatus.OK)
  leaveGroup(@Request() req, @Param('id') id: string) {
    return this.chatService.leaveGroup(req.user.sub, id, req.user.name);
  }

  @Patch('conversations/:id')
  updateGroup(@Request() req, @Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.chatService.updateGroup(req.user.sub, id, dto, req.user.name);
  }

  @Patch('conversations/:id/role')
  changeRole(@Request() req, @Param('id') id: string, @Body() dto: ChangeRoleDto) {
    return this.chatService.changeRole(req.user.sub, id, dto, req.user.name);
  }

  @Patch('conversations/:id/transfer')
  transferOwnership(@Request() req, @Param('id') id: string, @Body() dto: TransferOwnerDto) {
    return this.chatService.transferOwnership(req.user.sub, id, dto, req.user.name);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.OK)
  dissolveGroup(@Request() req, @Param('id') id: string) {
    return this.chatService.dissolveGroup(req.user.sub, id);
  }

  @Patch('conversations/:id/settings')
  updateSettings(@Request() req, @Param('id') id: string, @Body() dto: UpdateSettingsDto) {
    return this.chatService.updateSettings(req.user.sub, id, dto);
  }

  @Post('conversations/:id/members/:memberId/ban')
  @HttpCode(HttpStatus.OK)
  banMember(
    @Request() req,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() dto: BanMemberDto
  ) {
    return this.chatService.banMember(req.user.sub, id, memberId, dto, req.user.name);
  }

  @Delete('conversations/:id/members/:memberId/ban')
  @HttpCode(HttpStatus.OK)
  unbanMember(@Request() req, @Param('id') id: string, @Param('memberId') memberId: string) {
    return this.chatService.unbanMember(req.user.sub, id, memberId, req.user.name);
  }

  @Patch('conversations/:id/me')
  updateMySettings(@Request() req, @Param('id') id: string, @Body() dto: UpdateMySettingsDto) {
    return this.chatService.updateMySettings(req.user.sub, id, dto);
  }

  // ── Media / File / Link ────────────────────────────────────────────────

  @Get('conversations/:id/media')
  getConversationMedia(
    @Request() req,
    @Param('id') id: string,
    @Query('type') type: 'image' | 'file' | 'link',
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    return this.chatService.getConversationMedia(
      req.user.sub,
      id,
      type ?? 'image',
      cursor,
      limit ? parseInt(limit, 10) : 20
    );
  }

  // ── Reminders ──────────────────────────────────────────────────────────

  @Post('conversations/:conversationId/reminders')
  createReminder(
    @Request() req,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateReminderDto
  ) {
    return this.reminderService.createReminder(req.user.sub, conversationId, dto);
  }

  @Get('conversations/:conversationId/reminders')
  getReminders(@Request() req, @Param('conversationId') conversationId: string) {
    return this.reminderService.getReminders(req.user.sub, conversationId);
  }

  @Patch('reminders/:reminderId')
  updateReminder(
    @Request() req,
    @Param('reminderId') reminderId: string,
    @Body() dto: UpdateReminderDto
  ) {
    return this.reminderService.updateReminder(req.user.sub, reminderId, dto);
  }

  @Delete('reminders/:reminderId')
  deleteReminder(@Request() req, @Param('reminderId') reminderId: string) {
    return this.reminderService.deleteReminder(req.user.sub, reminderId);
  }

  @Post('reminders/:reminderId/complete')
  @HttpCode(HttpStatus.OK)
  completeReminder(@Request() req, @Param('reminderId') reminderId: string) {
    return this.reminderService.completeReminder(req.user.sub, reminderId);
  }

  @Post('reminders/:reminderId/rsvp')
  @HttpCode(HttpStatus.OK)
  rsvpReminder(
    @Request() req,
    @Param('reminderId') reminderId: string,
    @Body() dto: RsvpReminderDto
  ) {
    return this.reminderService.rsvpReminder(req.user.sub, reminderId, dto.name, dto.status);
  }

  // ── Notes ──────────────────────────────────────────────────────────────

  @Post('conversations/:conversationId/notes')
  createNote(
    @Request() req,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateNoteDto
  ) {
    return this.noteService.createNote(req.user.sub, conversationId, dto, req.user.name);
  }

  @Get('conversations/:conversationId/notes')
  getNotes(@Request() req, @Param('conversationId') conversationId: string) {
    return this.noteService.getNotes(req.user.sub, conversationId);
  }

  @Patch('notes/:noteId')
  updateNote(@Request() req, @Param('noteId') noteId: string, @Body() dto: UpdateNoteDto) {
    return this.noteService.updateNote(req.user.sub, noteId, dto, req.user.name);
  }

  @Delete('notes/:noteId')
  @HttpCode(HttpStatus.OK)
  deleteNote(@Request() req, @Param('noteId') noteId: string) {
    return this.noteService.deleteNote(req.user.sub, noteId, req.user.name);
  }
}
