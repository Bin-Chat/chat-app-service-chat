import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module';
import { KafkaProducerModule } from '../kafka/kafka-producer.module';

import { Conversation, ConversationSchema } from './schemas/conversation.schema';
import { Message, MessageSchema } from './schemas/message.schema';
import { Reminder, ReminderSchema } from './schemas/reminder.schema';
import { Note, NoteSchema } from './schemas/note.schema';
import { Poll, PollSchema } from './schemas/poll.schema';
import { Task, TaskSchema } from './schemas/task.schema';
import { ChatController, HealthController } from './chat.controller';
import { ChatService } from './chat.service';
import { ReminderService } from './reminder.service';
import { NoteService } from './note.service';
import { PollService } from './poll.service';
import { TaskService } from './task.service';
import { InternalChatController } from './internal-chat.controller';
import { InternalGuard } from '../auth/internal.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Reminder.name, schema: ReminderSchema },
      { name: Note.name, schema: NoteSchema },
      { name: Poll.name, schema: PollSchema },
      { name: Task.name, schema: TaskSchema },
    ]),
    AuthModule,
    KafkaProducerModule,
  ],
  providers: [ChatService, ReminderService, NoteService, PollService, TaskService, InternalGuard],
  controllers: [HealthController, ChatController, InternalChatController],
  exports: [ChatService, ReminderService, NoteService, PollService, TaskService],
})
export class ChatModule {}
