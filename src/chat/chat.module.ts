import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module';
import { KafkaProducerModule } from '../kafka/kafka-producer.module';

import { Conversation, ConversationSchema } from './schemas/conversation.schema';
import { Message, MessageSchema } from './schemas/message.schema';
import { Reminder, ReminderSchema } from './schemas/reminder.schema';
import { Note, NoteSchema } from './schemas/note.schema';
import { ChatController, HealthController } from './chat.controller';
import { ChatService } from './chat.service';
import { ReminderService } from './reminder.service';
import { NoteService } from './note.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Reminder.name, schema: ReminderSchema },
      { name: Note.name, schema: NoteSchema },
    ]),
    AuthModule,
    KafkaProducerModule,
  ],
  providers: [ChatService, ReminderService, NoteService],
  controllers: [HealthController, ChatController],
  exports: [ChatService, ReminderService, NoteService],
})
export class ChatModule {}
