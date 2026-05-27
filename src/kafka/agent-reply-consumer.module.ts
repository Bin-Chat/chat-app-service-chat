import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Conversation, ConversationSchema } from '../chat/schemas/conversation.schema';
import { Message, MessageSchema } from '../chat/schemas/message.schema';

import { AgentReplyConsumer } from './agent-reply.consumer';
import { KafkaProducerModule } from './kafka-producer.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: Conversation.name, schema: ConversationSchema },
    ]),
    KafkaProducerModule,
  ],
  controllers: [AgentReplyConsumer],
})
export class AgentReplyConsumerModule {}
